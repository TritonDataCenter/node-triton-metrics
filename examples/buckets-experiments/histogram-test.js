/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This can be used to test that the Prometheus simulator in error-estimator.js
 * produces the same values that an actual Prometheus instance. In order to use
 * this, you can run:
 *
 *  runner-debug.sh <input> <json> <chunksize> <value>
 *
 * where value is the value that the estimator generated for a given chunk. It
 * will then go through and output an object which represents the prometheus
 * state. You can copy that here into the `buckets` object below and then run
 * this somewhere you have bunyan and restify installed.
 *
 * Then point your Prometheus at the port this listens on, and run the query
 * output on startup.
 *
 * E.g.
 *
 *     histogram_quantile(0.95, histogram_test_1540589003748)
 *
 * which you should find matches the P95 value we calculated in the estimator
 * for that data.
 */

var bunyan = require('bunyan');
var restify = require('restify');

var buckets = {
  // Put the object output from runner-debug.sh here, e.g.:
  // "1": 3614,
  // "12": 3750,
  // "13": 3752,
  // "16": 3752,
  // "18": 3752,
  // "21": 3752,
  // "25": 3752,
  // "30": 3752,
  // "34": 3752,
  // "41": 3752,
  // "47": 3752,
  // "55": 3752,
  // "66": 3752,
  // ...
};

var HISTOGRAM_NAME;
var log = new bunyan({
    name: 'histogram-test',
    level: 'debug',
    serializers: {
        err: bunyan.stdSerializers.err,
        req: bunyan.stdSerializers.req,
        res: bunyan.stdSerializers.res
    }
});

function getMetrics(req, res, next) {
    var bucketKeys;
    var idx;
    var metrics = '';

    metrics = '# HELP ' + HISTOGRAM_NAME + ' test histogram of awesome\n' +
        '# TYPE ' + HISTOGRAM_NAME + ' histogram\n';

    bucketKeys = Object.keys(buckets).filter(function _filterBuckets(bucket) {
        if (Number.isNaN(Number(bucket))) {
            return false;
        }
        return true;
    }).sort(function _sortBuckets(a, b) { return (a - b); });

    for (idx = 0; idx < bucketKeys.length; idx++) {
        metrics = metrics + HISTOGRAM_NAME + '{le="' + bucketKeys[idx] + '"} ' + buckets[bucketKeys[idx]] + '\n';
    }
    metrics = metrics + HISTOGRAM_NAME + '{le="+Inf"} ' + buckets['+Inf'] + '\n';

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics);
    next();
}

function main() {
    var config = {log: log};
    var name;
    var server;

    server = restify.createServer(config);

    server.on('after', function _doLogging(req, res, route, err) {
        restify.auditLogger({log: log})(req, res, route, err);
    });

    HISTOGRAM_NAME = 'histogram_test_' + Date.now();

    server.get({
        name: 'GetMetrics',
        path: '/metrics'
    }, getMetrics);

    server.listen(8889, function _onListen() {
        log.info({
            histogramName: name,
            query: 'histogram_quantile(0.95, ' + HISTOGRAM_NAME + ')'
        }, '%s listening at %s', server.name, server.url);
    });
}

main();
