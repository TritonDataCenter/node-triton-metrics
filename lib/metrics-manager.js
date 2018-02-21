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
var VError = require('verror');

function getMetricsHandler(collector) {
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
    this.port = config.port;
    this.server = config.restify.createServer({serverName: 'Metrics'});
    this.server.get('/metrics', getMetricsHandler(collector));
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
            var nsPerSecond = 1e9;
            latency = process.hrtime(req._time);
            latencySeconds =
                (latency[0] * nsPerSecond + latency[1]) / nsPerSecond;
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
