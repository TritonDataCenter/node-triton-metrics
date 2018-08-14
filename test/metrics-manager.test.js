/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Metrics-manager test
 */

var bunyan = require('bunyan');
var format = require('util').format;
var fs = require('fs');
var restify = require('restify');
var restifyClients = require('restify-clients');
var test = require('tape');
var vasync = require('vasync');

var helper = require('./helpers');
var tritonMetrics = require('..');

var metricsManager;
var promLabels;

var client = restifyClients.createStringClient({
    connectTimeout: 250,
    retry: false,
    url: 'http://localhost:8881/metrics'
});

test('setup', function(t) {
    var staticLabels = {
        datacenter: 'test-datacenter',
        instance: 'test-instance',
        server: 'test-server',
        service: 'test-service'
    };

    var shortUserAgent = client.headers['user-agent'].split(' ')[0];
    promLabels = [
        format('datacenter="%s"', staticLabels.datacenter),
        format('instance="%s"', staticLabels.instance),
        format('route="%s"', 'getmetrics'),
        format('server="%s"', staticLabels.server),
        format('service="%s"', staticLabels.service),
        format('status_code="%d"', 200),
        format('user_agent="%s"', shortUserAgent)
    ];

    metricsManager = tritonMetrics.createMetricsManager({
        log: bunyan.createLogger({
            name: 'metrics_test',
            level: process.env['LOG_LEVEL'] || 'error',
            stream: process.stderr
        }),
        staticLabels: staticLabels,
        address: '127.0.0.1',
        port: 8881,
        restify: restify
    });

    t.ok(metricsManager);
    t.end();
});

test('start server', function(t) {
    vasync.pipeline(
        {
            funcs: [
                function startServer(_, next) {
                    metricsManager.listen(function serverStarted() {
                        next();
                    });
                },
                function pingServer(_, next) {
                    client.get('/metrics', function(err, req, res, data) {
                        t.error(err);
                        t.equal(
                            res.statusCode,
                            200,
                            'The status code should be 200'
                        );
                        t.equal(data, '', 'response data should be empty');
                        next();
                    });
                }
            ]
        },
        t.end
    );
});

test('add restify metrics', function(t) {
    metricsManager.createRestifyMetrics();

    client.get('/metrics', function(_, req, res, data) {
        t.ok(data, 'response data should not be empty');
        t.end();
    });
});

test('add after handler and seed metrics', function(t) {
    metricsManager.server.on(
        'after',
        metricsManager.collectRestifyMetrics.bind(metricsManager)
    );

    client.get('/metrics', function(err, req, res, _) {
        t.error(err);
        t.end();
    });
});

test('collect restify request count', function(t) {
    var count;
    var updatedCount;
    var counterLabel = ['http_requests_completed'];
    var labels = promLabels.concat(counterLabel);

    vasync.pipeline(
        {
            funcs: [
                function collectCount(_, next) {
                    client.get('/metrics', function(err, req, res, data) {
                        t.error(err);
                        count = helper.getMetricCount(data, labels);
                        next();
                    });
                },
                function collectUpdatedCount(_, next) {
                    client.get('/metrics', function(err, req, res, data) {
                        t.error(err);
                        t.ok(data);
                        updatedCount = helper.getMetricCount(data, labels);
                        t.ok(updatedCount, 'updated request count');
                        t.equal(
                            updatedCount - count,
                            1,
                            'request count should increase by 1'
                        );
                        next();
                    });
                }
            ]
        },
        t.end
    );
});

test('collect restify histogram count', function(t) {
    var count;
    var updatedCount;
    var histogramLabels = [
        format('le="%s"', '+Inf'),
        'http_request_duration_seconds'
    ];
    var labels = promLabels.concat(histogramLabels);

    vasync.pipeline(
        {
            funcs: [
                function collectCount(_, next) {
                    client.get('/metrics', function(err, req, res, data) {
                        t.error(err);
                        count = helper.getMetricCount(data, labels);
                        next();
                    });
                },
                function collectUpdatedCount(_, next) {
                    client.get('/metrics', function(err, req, res, data) {
                        t.error(err);
                        t.ok(data);
                        updatedCount = helper.getMetricCount(data, labels);
                        t.ok(updatedCount, 'updated duration count');
                        t.equal(
                            updatedCount - count,
                            1,
                            'request duration count should increase by 1'
                        );
                        next();
                    });
                }
            ]
        },
        t.end
    );
});

test('create arbitrary metrics group', function(t) {
    var arbitraryLabels = [
        format('bar="%s"', 'baz'),
        format('first="%d"', 1),
        format('second="%d"', 2),
        'foo'
    ];

    metricsManager.collector.counter({
        name: 'foo',
        help: 'foo help'
    });

    var collectMetrics = function(first, second) {
        var labels = {
            bar: 'baz',
            first: first,
            second: second
        };

        metricsManager.collector.getCollector('foo').increment(labels);
    };

    metricsManager.createMetrics('arbitraryGroup', collectMetrics);
    metricsManager.collectMetrics('arbitraryGroup', 1, 2);

    client.get('/metrics', function(err, req, res, data) {
        t.error(err);
        var count = helper.getMetricCount(data, arbitraryLabels);
        t.equal(count, 1, 'count should be 1');
        t.end();
    });
});

var serverPath = './socket-test.sock';
var socketClient = restifyClients.createStringClient({
    connectTimeout: 250,
    retry: false,
    socketPath: serverPath
});

var socketMetricsManager;

test('setup socket server', function(t) {
    // Cleanup old server if last test run failed before teardown
    fs.unlink(serverPath, function unlinked(err) {
        if (err && err.code !== 'ENOENT') {
            t.error(err);
        }

        var staticLabels = {
            datacenter: 'test-datacenter',
            instance: 'test-instance',
            server: 'test-server',
            service: 'test-service'
        };

        socketMetricsManager = tritonMetrics.createMetricsManager({
            log: bunyan.createLogger({
                name: 'metrics_test',
                level: process.env['LOG_LEVEL'] || 'error',
                stream: process.stderr
            }),
            staticLabels: staticLabels,
            path: serverPath,
            restify: restify
        });

        t.ok(socketMetricsManager);
        t.end();
    });
});

test('start socket server', function(t) {
    vasync.pipeline(
        {
            funcs: [
                function startServer(_, next) {
                    socketMetricsManager.listen(function serverStarted() {
                        next();
                    });
                },
                function pingServer(_, next) {
                    socketClient.get('/metrics', function(err, req, res, data) {
                        t.error(err);
                        t.equal(
                            res.statusCode,
                            200,
                            'The status code should be 200'
                        );
                        t.equal(data, '', 'response data should be empty');
                        next();
                    });
                }
            ]
        },
        t.end
    );
});

test('teardown', function(t) {
    vasync.parallel(
        {
            funcs: [
                metricsManager.server.close.bind(metricsManager),
                socketMetricsManager.server.close.bind(socketMetricsManager)
            ]
        },
        t.end
    );
});
