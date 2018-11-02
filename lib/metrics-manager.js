/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * node-triton-metrics
 */

var v8 = require('v8');

var artedi = require('artedi');
var assert = require('assert-plus');
// NOTE: the gc-stats is also used in this file, but conditionally. It is
// require()d when createNodejsMetrics() is called to avoid overhead otherwise.
var gc_stats;
var vasync = require('vasync');
var VError = require('verror');

var EventloopMetrics = require('./eventloop-metrics');

var MS_PER_SECOND = 1e3;
var US_PER_SECOND = 1e6;
var NS_PER_SECOND = 1e9;

function getMetricsHandler(collector, preCollectFuncs) {
    function getMetrics(req, res, next) {
        /*
         * Restify GET requests will keep socket open until entire request
         * body is read. req.resume() is used to prevent connection leaks.
         *
         * More information at:
         * https://jira.joyent.us/browse/MANTA-3338
         * https://cr.joyent.us/#/c/2823/1/lib/other.js
         */
        req.on('end', function collectMetrics() {
            vasync.parallel({funcs: preCollectFuncs}, function _onPreCollected(
                preCollectErr
            ) {
                assert.ifError(
                    preCollectErr,
                    'preCollectFuncs should not callback with error'
                );

                collector.collect(artedi.FMT_PROM, function sendMetrics(
                    err,
                    metrics
                ) {
                    if (err) {
                        next(new VError(err, 'error retrieving metrics'));
                        return;
                    }
                    /*
                     * Content-Type header is set to indicate the Prometheus
                     * exposition format version
                     *
                     * More information at:
                     * https://github.com/prometheus/docs/blob/master/content/docs/instrumenting/exposition_formats.md#format-version-004
                     */
                    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
                    res.send(metrics);
                    next();
                });
            });
        });

        req.resume();
    }
    var chain = [getMetrics];
    return chain;
}

function MetricsManager(config) {
    assert.object(config, 'config');
    assert.optionalBool(
        config.handleUncaughtExceptions,
        'config.handleUncaughtExceptions'
    );
    assert.object(config.log, 'config.log');
    assert.object(config.restify, 'config.restify');
    assert.object(config.staticLabels, 'config.staticLabels');
    assert.string(
        config.staticLabels.datacenter,
        'config.staticLabels.datacenter'
    );
    assert.string(config.staticLabels.instance, 'config.staticLabels.instance');
    assert.string(config.staticLabels.server, 'config.staticLabels.server');
    assert.string(config.staticLabels.service, 'config.staticLabels.service');
    assert.optionalObject(config.metricOpts, 'config.metricOpts');

    if (config.port) {
        assert.string(config.address, 'config.address');
        assert.number(config.port, 'config.port');
    } else {
        assert.equal(undefined, config.address, 'config.address');
        assert.string(config.path, 'config.path');
    }

    var collector = artedi.createCollector({labels: config.staticLabels});
    var createOpts = {serverName: 'Metrics'};

    if (config.handleUncaughtExceptions !== undefined) {
        createOpts.handleUncaughtExceptions = config.handleUncaughtExceptions;
    }

    this.address = config.address;
    this.collector = collector;
    this.gcCounts = {};
    this.gcPauses = {};
    this.log = config.log;
    this.metricOpts = config.metricOpts;
    this.metricsGroups = {};
    this.path = config.path;
    this.port = config.port;
    this.preCollectFuncs = [];
    this.previousCpuUsage = {user: 0, system: 0};
    this.server = config.restify.createServer(createOpts);
    this.server.get(
        '/metrics',
        getMetricsHandler(collector, this.preCollectFuncs)
    );
}

MetricsManager.prototype.listen = function startMetricsServer(callback) {
    var self = this;
    var port = self.port || self.path;

    self.server.listen(port, self.address, function serverStarted() {
        if (self.port) {
            self.log.info('metrics server started on %s', self.server.url);
        } else {
            self.log.info('metrics server started on %s', self.path);
        }
        callback();
    });
};

MetricsManager.prototype.close = function stopMetricsServer(callback) {
    var self = this;

    self.server.close(function serverStopped() {
        self.log.info('metrics server has shutdown');
        callback();
    });
};

MetricsManager.prototype.addPreCollectFunc = function addPreCollectFunc(func) {
    assert.func(func, 'func');

    this.preCollectFuncs.push(func);
};

MetricsManager.prototype.createMetrics = function createMetrics(
    name,
    collectMetrics
) {
    assert.string(name, 'name');
    assert.func(collectMetrics, 'collectMetrics');

    this.metricsGroups[name] = collectMetrics;
};

MetricsManager.prototype.collectMetrics = function updateMetrics(name) {
    assert.string(name, 'name');

    var collectArgs = Array.prototype.slice.call(arguments, 1);
    this.metricsGroups[name].apply(this, collectArgs);
};

function gcType(typeNum) {
    // See: https://github.com/nodejs/node/blob/554fa24916c5c6d052b51c5cee9556b76489b3f7/deps/v8/include/v8.h#L6137-L6144
    switch (Number(typeNum)) {
        case 1:
            return 'scavenge';
        case 2:
            return 'mark/sweep/compact';
        case 4:
            return 'incremental';
        case 8:
            return 'weak/phantom';
        case 15:
            return 'all';
        default:
            return 'unknown/' + typeNum;
    }
}

//
// Metrics here were inspired by (among other sources):
//
// https://github.com/Netflix-Skunkworks/atlas-node-client
// https://github.com/RuntimeTools/appmetrics
// https://github.com/siimon/prom-client
// https://www.oreilly.com/ideas/top-nodejs-metrics-to-watch
//
MetricsManager.prototype.createNodejsMetrics = function createNodejsMetrics() {
    var self = this;

    var collectors = {
        counter: {
            nodejs_eventloop_lag_seconds_total: {
                source: 'eventloopMetrics',
                key: 'lagSum',
                help:
                    'Represents the total number of seconds setTimeout() ' +
                    'has taken beyond the timeout when sampling the eventloop.'
            },
            nodejs_eventloop_samples_total: {
                source: 'eventloopMetrics',
                key: 'sampleCount',
                help: 'Number of times eventloop data has been collected.'
            },
            nodejs_eventloop_tick_count_total: {
                source: 'eventloopMetrics',
                key: 'loopCountSum',
                help:
                    'Number of times eventloop has ticked since start of ' +
                    'observation.'
            },
            nodejs_eventloop_time_seconds_total: {
                source: 'eventloopMetrics',
                key: 'loopTimeSum',
                help:
                    'Total amount of time spent in the eventloop since ' +
                    'start of observation.'
            },
            nodejs_gc_execution_count_total: {
                source: 'special',
                help: 'Number of times node GC has run.'
            },
            nodejs_gc_pause_seconds_total: {
                source: 'special',
                help: 'Total number of seconds node has spent paused for GC.'
            },
            nodejs_system_cpu_seconds_total: {
                source: 'cpuUsage',
                key: 'system',
                help: 'Number of CPU seconds spent in system code.'
            },
            nodejs_user_cpu_seconds_total: {
                source: 'cpuUsage',
                key: 'user',
                help: 'Number of CPU seconds spent in user code.'
            }
        },
        gauge: {
            nodejs_active_handles_count: {
                source: 'special',
                help:
                    'Number of active handles reported by ' +
                    'process._getActiveHandles().'
            },
            nodejs_active_requests_count: {
                source: 'special',
                help:
                    'Total number of active requests reported by ' +
                    'process._getActiveRequests().'
            },
            nodejs_eventloop_max_lag_seconds: {
                source: 'eventloopMetrics',
                key: 'lagMax',
                help: 'Maximum number of seconds setTimeout() was delayed.'
            },
            nodejs_eventloop_max_tick_count: {
                source: 'eventloopMetrics',
                key: 'loopCountMax',
                help: 'Maximum number of ticks in a single setTimeout() loop.'
            },
            nodejs_eventloop_max_time_seconds: {
                source: 'eventloopMetrics',
                key: 'loopTimeMax',
                help:
                    'Maximum number of seconds spent on a single eventloop ' +
                    'tick.'
            },
            nodejs_eventloop_min_lag_seconds: {
                source: 'eventloopMetrics',
                key: 'lagMin',
                help: 'Minimum number of seconds setTimeout() was delayed.'
            },
            nodejs_eventloop_min_tick_count: {
                source: 'eventloopMetrics',
                key: 'loopCountMin',
                help: 'Minimum number of ticks in a single setTimeout() loop.'
            },
            nodejs_eventloop_min_time_seconds: {
                source: 'eventloopMetrics',
                key: 'loopTimeMin',
                help:
                    'Minimum number of seconds spent on a single eventloop ' +
                    'tick.'
            },
            nodejs_memory_external_bytes: {
                source: 'memoryUsage',
                key: 'external',
                help:
                    'Number of bytes of memory used by C++ objects bound to ' +
                    'JavaScript objects managed by V8.'
            },
            nodejs_memory_heapTotal_bytes: {
                source: 'memoryUsage',
                key: 'heapTotal',
                help: "Number of total bytes in V8's heap."
            },
            nodejs_memory_heapUsed_bytes: {
                source: 'memoryUsage',
                key: 'heapUsed',
                help: "Number of used bytes in V8's heap"
            },
            nodejs_memory_rss_bytes: {
                source: 'memoryUsage',
                key: 'rss',
                help: 'Number of bytes in main memory for the process'
            },
            nodejs_process_start_time_seconds: {
                source: 'special',
                help:
                    'Start time of this process in seconds since ' +
                    '1970-01-01T00:00:00Z'
            },
            nodejs_V8_does_zap_garbage_boolean: {
                source: 'v8HeapStats',
                key: 'does_zap_garbage',
                help:
                    'A 0/1 boolean, which signifies whether the ' +
                    '--zap_code_space option is enabled or not.'
            },
            nodejs_V8_heap_size_executable_bytes: {
                source: 'v8HeapStats',
                key: 'total_heap_size_executable',
                help: 'Number of bytes for compiled bytecode and JITed code.'
            },
            nodejs_V8_heap_size_limit_bytes: {
                source: 'v8HeapStats',
                key: 'heap_size_limit',
                help: 'Limit on the size of the V8 heap.'
            },
            nodejs_V8_malloced_memory_bytes: {
                source: 'v8HeapStats',
                key: 'malloced_memory',
                help: 'Current bytes of memory that has been malloc()ed.'
            },
            nodejs_V8_peak_malloced_memory_bytes: {
                source: 'v8HeapStats',
                key: 'peak_malloced_memory',
                help: 'Maximum bytes of memory that has been malloc()ed.'
            },
            nodejs_V8_total_available_size_bytes: {
                source: 'v8HeapStats',
                key: 'total_available_size',
                help: 'Number of bytes available in the V8 heap.'
            },
            nodejs_V8_total_heap_size_bytes: {
                source: 'v8HeapStats',
                key: 'total_heap_size',
                help: 'Total bytes V8 has allocated for its heap.'
            },
            nodejs_V8_total_physical_size_bytes: {
                source: 'v8HeapStats',
                key: 'total_physical_size',
                help: 'Total committed size of V8.'
            },
            nodejs_V8_used_heap_size_bytes: {
                source: 'v8HeapStats',
                key: 'used_heap_size',
                help: 'Number of bytes allocated in the V8 heap.'
            }
        }
    };

    function onEachCollector(fn, callback) {
        var idx;
        var keys;
        var name;
        var type;
        var typeIdx;
        var types = ['counter', 'gauge'];

        for (typeIdx = 0; typeIdx < types.length; typeIdx++) {
            type = types[typeIdx];

            keys = Object.keys(collectors[type]);
            for (idx = 0; idx < keys.length; idx++) {
                name = keys[idx];

                fn(type, name);
            }
        }

        if (callback !== undefined) {
            callback();
        }
    }

    function collectMetrics(cb) {
        var cpuUsage;
        var data = {};
        var gcTypeNum;
        var idx;
        var keys;

        // Fill in "special" metrics that don't come from one of the structures
        // we populate below (cpuUsage, memoryUsage, etc.)
        collectors.gauge['nodejs_active_handles_count']._handle.set(
            process._getActiveHandles().length
        );
        collectors.gauge['nodejs_active_requests_count']._handle.set(
            process._getActiveRequests().length
        );
        collectors.gauge['nodejs_process_start_time_seconds']._handle.set(
            Math.floor(Date.now() / MS_PER_SECOND - process.uptime())
        );

        // Passing in the previous value gives us just the delta, so we can just
        // add that. We set to 0's initially so that the first value gets
        // everything so far.
        cpuUsage = process.cpuUsage(self.previousCpuUsage);
        data.cpuUsage = {
            system: cpuUsage.system / US_PER_SECOND,
            user: cpuUsage.user / US_PER_SECOND
        };
        // Add the previous values back in since new values are a delta.
        cpuUsage.system += self.previousCpuUsage.system;
        cpuUsage.user += self.previousCpuUsage.user;
        self.previousCpuUsage = cpuUsage;

        data.eventloopMetrics = self.eventloopMetrics.get();
        // Times are in nanoseconds, convert to seconds
        data.eventloopMetrics.lagMax /= NS_PER_SECOND;
        data.eventloopMetrics.lagMin /= NS_PER_SECOND;
        data.eventloopMetrics.lagSum /= NS_PER_SECOND;
        data.eventloopMetrics.loopTimeMax /= NS_PER_SECOND;
        data.eventloopMetrics.loopTimeMin /= NS_PER_SECOND;
        data.eventloopMetrics.loopTimeSum /= NS_PER_SECOND;

        data.memoryUsage = process.memoryUsage();
        data.v8HeapStats = v8.getHeapStatistics();

        keys = Object.keys(self.gcCounts);
        for (idx = 0; idx < keys.length; idx++) {
            gcTypeNum = keys[idx];

            collectors.counter['nodejs_gc_execution_count_total']._handle.add(
                self.gcCounts[gcTypeNum],
                {gcType: gcType(gcTypeNum)}
            );
            collectors.counter['nodejs_gc_pause_seconds_total']._handle.add(
                self.gcPauses[gcTypeNum] / NS_PER_SECOND,
                {gcType: gcType(gcTypeNum)}
            );

            // Since we've added these to the counters, we'll delete so they're
            // reset next time. We don't just set to 0, since then we'd still be
            // adding 0 to the collector every time, even if this type never
            // happens again.
            delete self.gcCounts[gcTypeNum];
            delete self.gcPauses[gcTypeNum];
        }

        // FUTURE: Open FDs: readdir /proc/self/fd and count .length?

        // Now actually collect the remaining data into the artedi metrics.
        onEachCollector(function _updateArtediCollector(type, name) {
            var obj = collectors[type][name];
            var value;

            if (obj.source === 'special') {
                // we should have collected these above.
                return;
            }

            // Special case for eventloop metrics: if we haven't collected any
            // samples, don't update values (since that would break *Max).
            if (obj.source === 'eventloopMetrics') {
                if (
                    data.eventloopMetrics.sampleCount === 0 &&
                    ['lagMax', 'lagMin', 'lagSum'].indexOf(name) !== -1
                ) {
                    return;
                }
                if (
                    data.eventloopMetrics.loopCountSum === 0 &&
                    [
                        'loopTimeMax',
                        'loopTimeMin',
                        'loopTimeSum',
                        'loopCountMax',
                        'loopCountMin',
                        'loopCountSum'
                    ].indexOf(name) !== -1
                ) {
                    return;
                }
            }

            // This will blow up if obj.source is not in data, but that's what
            // we want since that's a programmer error.
            value = data[obj.source][obj.key];

            // These 3 are only available on node >= 7.2.0, so if we don't have
            // them, we'll just not collect them.
            if (
                obj.source === 'v8HeapStats' &&
                [
                    'does_zap_garbage',
                    'peak_malloced_memory',
                    'malloced_memory'
                ].indexOf(obj.key) !== -1 &&
                value === undefined
            ) {
                return;
            }

            switch (type) {
                case 'counter':
                    // cannot add negative values, so use 0 if negative
                    obj._handle.add(Math.max(0, value));
                    break;
                case 'gauge':
                    obj._handle.set(value);
                    break;
                default:
                    assert.fail('Unexpected type: ' + type);
                    break;
            }
        }, cb);
    }

    // Start the eventloop metric collector (will loop itself via setTimeout)
    self.eventloopMetrics = new EventloopMetrics();
    self.eventloopMetrics.start();

    // Start the GC collector. It will collect the values on every GC event.
    gc_stats = require('gc-stats')();
    gc_stats.on('stats', function(gcStats) {
        if (self.gcCounts[gcStats.gctype] === undefined) {
            // These are always updated together, so if one is undefined they
            // both will be.
            self.gcCounts[gcStats.gctype] = 0;
            self.gcPauses[gcStats.gctype] = 0;
        }
        self.gcCounts[gcStats.gctype]++;
        self.gcPauses[gcStats.gctype] += gcStats.pause; // nanoseconds

        // NOTE: There are more fields in this output that we're not
        // currently tracking. Including numbers of bytes before/after/diff
        // for different types of memory.
        self.log.trace({stats: gcStats}, 'nodejs GC detected');
    });

    // Create Artedi Collectors
    onEachCollector(function _createArtediCollector(type, name) {
        var obj = collectors[type][name];

        obj._handle = self.collector[type]({
            name: name,
            help: obj.help,
            labels: self._getLabels(name)
        });
    });

    // collect the metrics when someone calls `/metrics`
    self.addPreCollectFunc(collectMetrics);

    self.createMetrics('nodejs', collectMetrics);
};

MetricsManager.prototype._getBuckets = function _getBuckets(metricName) {
    var self = this;

    var buckets = [];

    if (
        self.metricOpts !== undefined &&
        self.metricOpts.hasOwnProperty(metricName) &&
        self.metricOpts[metricName].hasOwnProperty('buckets')
    ) {
        // We have specific buckets for this metric, use those.
        buckets = self.metricOpts[metricName].buckets;
    } else {
        // Default buckets look like:
        //
        //      0.001
        //      [0.001] 0.002 0.004 0.006 0.008 0.01
        //      [0.01] 0.02 0.04 0.06 0.08 0.1
        //      [0.1] 0.2 0.4 0.6 0.8 1
        //      [1] 2 4 6 8 10
        //      [10] 20 40 60 80 100
        //      [100] 200 400 600 800 1000
        //      [1000] 2000 4000
        //
        buckets = artedi
            .logLinearBuckets(10, -5, 3, 5)
            .filter(function _trimBuckets(v) {
                // Limit to >= 0.001 and <= 4000 as this is the range of
                // observed values for all Triton APIs we surveyed across
                // a month of production data.
                if (v > 4000 || v < 0.001) {
                    return false;
                }
                return true;
            });
    }

    return buckets;
};

MetricsManager.prototype._getLabels = function _getLabels(metricName) {
    var self = this;

    var labels = {};

    if (
        self.metricOpts !== undefined &&
        self.metricOpts.hasOwnProperty(metricName) &&
        self.metricOpts[metricName].hasOwnProperty('labels')
    ) {
        // We have specific labels for this metric, use those.
        labels = self.metricOpts[metricName].labels;
    }

    if (!labels.hasOwnProperty('buckets_version')) {
        labels.buckets_version = '1';
    }

    return labels;
};

MetricsManager.prototype.createRestifyMetrics = function createRestifyMetrics() {
    var self = this;

    self.collector.counter({
        name: 'http_requests_completed',
        help: 'count of requests completed',
        labels: self._getLabels('http_requests_completed')
    });

    self.collector.histogram({
        name: 'http_request_duration_seconds',
        help: 'total time to process requests',
        buckets: self._getBuckets('http_request_duration_seconds'),
        labels: self._getLabels('http_request_duration_seconds')
    });

    function collectMetrics(req, res, route) {
        var latency;
        var latencySeconds;
        var routeName = route ? route.name || route : 'unknown';
        var userAgent = req.userAgent();

        // Only the first token is added to the label to prevent cardinality
        // issues
        var shortUserAgent = userAgent ? userAgent.split(' ')[0] : 'unknown';

        var labels = {
            route: routeName,
            method: req.method,
            user_agent: shortUserAgent,
            status_code: res.statusCode
        };

        if (typeof req._time === 'number') {
            latency = Date.now() - req._time;
            latencySeconds = latency / 1000;
        } else {
            latency = process.hrtime(req._time);
            latencySeconds =
                (latency[0] * NS_PER_SECOND + latency[1]) / NS_PER_SECOND;
        }

        self.collector
            .getCollector('http_requests_completed')
            .increment(labels);
        self.collector
            .getCollector('http_request_duration_seconds')
            .observe(latencySeconds, labels);
    }

    self.createMetrics('restify', collectMetrics);
};

MetricsManager.prototype.collectRestifyMetrics = function collectRestifyMetrics(
    req,
    res,
    route
) {
    this.collectMetrics('restify', req, res, route);
};

function createMetricsManager(options) {
    return new MetricsManager(options);
}

module.exports = {
    createMetricsManager: createMetricsManager
};
