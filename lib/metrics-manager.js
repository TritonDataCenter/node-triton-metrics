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

var artedi = require('artedi');
var assert = require('assert-plus');
// NOTE: gc-stats is also used here, but conditionally. Only require()d when
// createGCMetrics() is called to avoid overhead in other cases.
var gc_stats;
var vasync = require('vasync');
var VError = require('verror');

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
    assert.string(config.address, 'config.address');
    assert.number(config.port, 'config.port');

    var collector = artedi.createCollector({labels: config.staticLabels});
    this.collector = collector;
    this.address = config.address;
    this.log = config.log;
    this.metricsGroups = {};
    this.preCollectFuncs = [];
    this.previousCpuUsage = {user: 0, system: 0};
    this.port = config.port;
    this.server = config.restify.createServer({serverName: 'Metrics'});
    this.server.get(
        '/metrics',
        getMetricsHandler(collector, this.preCollectFuncs)
    );
}

MetricsManager.prototype.listen = function startMetricsServer(callback) {
    var self = this;

    self.server.listen(self.port, self.address, function serverStarted() {
        self.log.info('metrics server started on %s', self.server.url);
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
    switch (typeNum) {
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
// Most of the metrics here were inspired by:
//
// https://github.com/siimon/prom-client/blob/master/lib/metrics
//
MetricsManager.prototype.createNodeMetrics = function createNodeMetrics() {
    var self = this;

    var activeHandlesGauge;
    var activeRequestsGauge;
    var eventloopLagGauge;
    var processStartTimeGauge;
    var processCpuSystemCounter;
    var processCpuUserCounter;
    var processMemoryExternalGauge;
    var processMemoryHeapTotalGauge;
    var processMemoryHeapUsedGauge;
    var processMemoryRssGauge;

    activeHandlesGauge = self.collector.gauge({
        name: 'node_active_handles_total',
        help:
            'Total number of active handles reported by ' +
            'process._getActiveHandles()'
    });

    activeRequestsGauge = self.collector.gauge({
        name: 'node_active_requests_total',
        help:
            'Total number of active requests reported by ' +
            'process._getActiveRequests()'
    });

    eventloopLagGauge = self.collector.gauge({
        name: 'node_eventloop_lag_seconds',
        help: 'Time taken for setImmediate to run on event loop'
    });

    processCpuSystemCounter = self.collector.counter({
        name: 'node_process_system_cpu_seconds',
        help: 'Number of CPU seconds spent in system code'
    });

    processCpuUserCounter = self.collector.counter({
        name: 'node_process_user_cpu_seconds',
        help: 'Number of CPU seconds spent in user code'
    });

    processMemoryExternalGauge = self.collector.gauge({
        name: 'node_process_memory_external_bytes',
        help:
            'Number of bytes of memory used by C++ objects bound to ' +
            'JavaScript objects managed by V8'
    });

    processMemoryHeapTotalGauge = self.collector.gauge({
        name: 'node_process_memory_heapTotal_bytes',
        help: "Number of total bytes in V8's heap"
    });

    processMemoryHeapUsedGauge = self.collector.gauge({
        name: 'node_process_memory_heapUsed_bytes',
        help: "Number of used bytes in V8's heap"
    });

    processMemoryRssGauge = self.collector.gauge({
        name: 'node_process_memory_rss_bytes',
        help: 'Number of bytes in main memory for the process'
    });

    processStartTimeGauge = self.collector.gauge({
        name: 'node_process_start_time_seconds',
        help: 'Start time of this process in seconds since 1970-01-01T00:00:00Z'
    });

    function collectMetrics(cb) {
        var cpuUsage;
        var memUsage;
        var start;

        function measureEventloopLag() {
            var elapsed;
            var timeDelta;

            timeDelta = process.hrtime(start);
            elapsed = timeDelta[0] + timeDelta[1] / NS_PER_SECOND;

            eventloopLagGauge.set(elapsed);
        }

        start = process.hrtime();
        setImmediate(measureEventloopLag);

        activeHandlesGauge.set(process._getActiveHandles().length);
        activeRequestsGauge.set(process._getActiveRequests().length);

        processStartTimeGauge.set(
            Math.floor(Date.now() / MS_PER_SECOND - process.uptime())
        );

        memUsage = process.memoryUsage();
        processMemoryExternalGauge.set(memUsage.external);
        processMemoryHeapTotalGauge.set(memUsage.heapTotal);
        processMemoryHeapUsedGauge.set(memUsage.heapUsed);
        processMemoryRssGauge.set(memUsage.rss);

        // Passing in the previous value gives us just the delta, so we can just
        // add that. We set to 0's initially so that the first value gets
        // everything so far.
        cpuUsage = process.cpuUsage(self.previousCpuUsage);
        processCpuSystemCounter.add(cpuUsage.system / US_PER_SECOND);
        processCpuUserCounter.add(cpuUsage.user / US_PER_SECOND);
        // add the previous values back in since new values are a delta.
        cpuUsage.system += self.previousCpuUsage.system;
        cpuUsage.user += self.previousCpuUsage.user;
        self.previousCpuUsage = cpuUsage;

        if (cb !== 'undefined') {
            cb();
        }
    }

    // collect the metrics when someone calls `/metrics`
    self.addPreCollectFunc(collectMetrics);

    // FUTURE: Open FDs: readdir /proc/self/fd and count .length?

    self.createMetrics('node_core', collectMetrics);
};

MetricsManager.prototype.createGCMetrics = function createGCMetrics() {
    var self = this;

    var gcExecutions;
    var gcPauseSecs;

    gcExecutions = self.collector.counter({
        name: 'node_gc_executions_total',
        help: 'number of times node GC has run'
    });

    gcPauseSecs = self.collector.counter({
        name: 'node_gc_pause_total_seconds',
        help: 'total number of seconds node has spent paused for GC'
    });

    // Require gc-stats now that the caller wants them.
    gc_stats = require('gc-stats')();

    gc_stats.on('stats', function(stats) {
        var pauseSecs = stats.pause / NS_PER_SECOND;

        gcExecutions.increment({
            gcType: gcType(stats.gctype)
        });

        gcPauseSecs.add(pauseSecs, {
            gcType: gcType(stats.gctype)
        });

        // NOTE: There are more fields in this output that we're not currently
        // tracking. Including numbers of bytes before/after/diff for different
        // types of memory.
        self.log.trace({stats: stats}, 'GC happened');
    });

    function collectMetrics(/* req, res, route */) {
        // do nothing, collection happens when GC happens
        return;
    }

    self.createMetrics('node_gc', collectMetrics);
};

MetricsManager.prototype.createRestifyMetrics = function createRestifyMetrics() {
    var self = this;

    self.collector.counter({
        name: 'http_requests_completed',
        help: 'count of requests completed'
    });

    self.collector.histogram({
        name: 'http_request_duration_seconds',
        help: 'total time to process requests'
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
