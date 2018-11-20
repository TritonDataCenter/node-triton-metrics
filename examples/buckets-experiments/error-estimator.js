/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

// Run with buckets as args and a file full of numbers (one per line) on stdin.
//
// E.g.:
//
// node examples/error-estimator.js 0.1 0.5 1 < myfile.txt
//
// IMPORTANT: This is very much a prototype, use at your own risk.
//

var readline = require('readline');

var assert = require('assert-plus');
var tabula = require('tabula');

// How many lines of input to process at once
var CHUNK_SIZE = process.env.CHUNK_SIZE ? Number(process.env.CHUNK_SIZE) : 100000;

var argv = process.argv;
var prevStartTime;
var startTime = process.hrtime();


// This holds the data very gently.
function DataBox(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.array(opts.buckets, 'opts.buckets');

    var idx;

    self.buckets = opts.buckets;
    self.data = [];
    self.promData = {
        sum: 0,
        '+Inf': 0
    };
    self.sorted = true; // [] is sorted

    for (idx = 0; idx < self.buckets.length; idx++) {
        self.promData[self.buckets[idx]] = 0;
    }
}

DataBox.prototype.addDatum = function addDatum(value) {
    var self = this;
    var idx;

    self.sorted = false; // we're appending, so no longer sorted
    self.data.push(value);

    // Basically mimicks how prometheus does bucketing
    // update every bucket that's > value, and then update sum and +Inf
    for (idx = 0; idx < self.buckets.length; idx++) {
        if (value <= self.buckets[idx]) {
            self.promData[self.buckets[idx]]++;
        }
    }
    self.promData['+Inf']++;
    self.promData.sum += value;
};

DataBox.prototype.getRealQuantile = function getRealQuantile(q) {
    var self = this;

    assert.number(q, 'q');
    assert.ok(self.data.length > 0, 'must have data');
    assert.ok(q > 0 && q < 1, 'must have: 0 < q < 1');

    var idx;

    if (!self.sorted) {
        self.data.sort(function _sortData(a, b) { return (a - b); });
        self.sorted = true;
    }

    // Calculating the actual percentile is done by finding the index of the
    // percentile value * the number of elements. Since data is sorted, this
    // gives us the index of the value below which q*100 percent of the elements
    // are found.
    idx = Math.floor(q * self.data.length);

    // Need to subtract 1 because of 0 indexing for arrays, we want the "idx"th value.
    return (self.data[Math.max(0, idx - 1)]);
};

// See https://github.com/prometheus/prometheus/blob/c4a6acfb1e4f11244db3cbe8d777d249304a6ecf/promql/quantile.go#L49-L108
DataBox.prototype.getPrometheusQuantile = function getPrometheusQuantile(q) {
    var self = this;

    var b = -1;
    var bucketEnd;
    var bucketStart;
    var count;
    var idx;
    var rank;
    var value;

    assert.number(q, 'q');
    assert.ok(q > 0 && q < 1, 'must have: 0 < q < 1');
    assert.ok(self.buckets.length >= 2, 'must have at least 2 buckets');

    rank = self.promData['+Inf'] * q;

    // find the first bucket that's >= our rank value
    for (idx = 0; (b < 0) && (idx < self.buckets.length); idx++) {
        if (self.promData[self.buckets[idx]] >= rank) {
            b = idx;
        }
    }

    if (b === -1) {
        // The rank value is in +Inf, what prometheus does here is return the
        // largest bucket.
        return (self.buckets[self.buckets.length - 1]);
    } else if (b === 0 && self.buckets[0] <= 0) {
        // When the rank is in the first bucket, and the bucket value is <= 0,
        // return that bucket value.
        return (self.buckets[0]);
    } else {
        bucketStart = 0;
        bucketEnd = self.buckets[b];
        count = self.promData[self.buckets[b]];

        if (b > 0) {
            bucketStart = self.buckets[b - 1];
            count -= self.promData[self.buckets[b - 1]];
            rank -= self.promData[self.buckets[b - 1]];
        }

        value = bucketStart + (bucketEnd-bucketStart)*(rank/count);

        // For debugging, you can pass in a prometheus value and get some
        // additional information about how we generated that value.
        if (process.env.DEBUG_PROM_VALUE !== undefined
            && Number(process.env.DEBUG_PROM_VALUE) === +(value.toFixed(4))) {

            console.error('# bucketStart + (bucketEnd - bucketStart) * (rank / count) = value');
            console.error('# Returning %d + (%d - %d) * (%d / %d) = %d',
                bucketStart, bucketEnd, bucketStart, rank, count, value);
            console.log(JSON.stringify(self.promData, null, 2));
        }

        return (value);
    }
};

DataBox.prototype.length = function length() {
    var self = this;

    return (self.data.length);
};

DataBox.prototype.first10 = function first10() {
    var self = this;

    return (self.data.slice(0, 10));
};


function qToP(q) {
    var pvalue;

    pvalue = 'P' + (+((q * 100).toFixed(5)));

    return (pvalue);
}

function getResult(databox) {
    var actual;
    var idx;
    var prometheus;
    var q;
    var quantiles = [0.999, 0.99, 0.98, 0.95, 0.75, 0.50, 0.25];
    var result;

    result = {
        count: databox.length(),
        quantiles: {}
    };

    // Include the first 10 values of this chunk to help us find the data if we
    // need to later.
    console.error('# first 10: %s', databox.first10().join(', '));
    for (idx = 0; idx < quantiles.length; idx++) {
        q = quantiles[idx];

        actual = databox.getRealQuantile(q);
        prometheus = databox.getPrometheusQuantile(q);

        result.quantiles[q] = {
            actual: actual,
            error: +(Math.abs(1 - (Math.max(prometheus, actual) / Math.min(prometheus, actual))) * 100).toFixed(2),
            prometheus: prometheus
        };

        console.error('# %s actual: %d, prometheus: %d, error: %d',
            qToP(q), actual, +(prometheus.toFixed(4)), result.quantiles[q].error);
    }
    console.error('');

    return (result);
}

function lapTime() {
    var elapsed;
    var timeDelta = process.hrtime(prevStartTime);

    prevStartTime = process.hrtime();

    elapsed = ((timeDelta[0] * 1e9 + timeDelta[1]) / 1e9);

    return (elapsed);
}

function outputResults(buckets, results) {
    var count = 0;
    var elapsed;
    var idx;
    var magnitude;
    var outputItems;
    var prevMagnitude;
    var q;
    var qdata = {};
    var qidx;
    var quantiles;
    var result;
    var timeDelta;

    console.error('\n# SUMMARY\n#');

    // Print the list of buckets formatted by base 10 magnitude
    console.error('# BUCKETS(%d)\n#', buckets.length);
    process.stderr.write('#     ');
    for (idx = 0; idx < buckets.length; idx++) {
        magnitude = Math.floor(Math.log10(buckets[idx]));
        if (prevMagnitude === undefined) {
            prevMagnitude = magnitude;
        }
        if (buckets[idx] === Math.pow(10, magnitude)) {
            process.stderr.write(' ' + buckets[idx] + '\n#      [' + buckets[idx] + ']');
        } else if (prevMagnitude === magnitude) {
            process.stderr.write(' ' + buckets[idx]);
        } else {
            process.stderr.write('\n#      ' + buckets[idx]);
        }
        prevMagnitude = magnitude;
    }
    console.error('\n#');


    for (idx = 0; idx < results.length; idx++) {
        result = results[idx];
        quantiles = Object.keys(result.quantiles);
        count += result.count;

        for (qidx = 0; qidx < quantiles.length; qidx++) {
            q = quantiles[qidx];
            if (qdata[q] === undefined) {
                qdata[q] = {
                    max_e: result.quantiles[q].error,
                    min_e: result.quantiles[q].error,
                    sum_e: result.quantiles[q].error,
                    max_a: result.quantiles[q].actual,
                    min_a: result.quantiles[q].actual,
                    sum_a: result.quantiles[q].actual,
                    max_p: result.quantiles[q].prometheus,
                    min_p: result.quantiles[q].prometheus,
                    sum_p: result.quantiles[q].prometheus
                };
            } else {
                // update error info
                if (result.quantiles[q].error > qdata[q].max_e) {
                    qdata[q].max_e = result.quantiles[q].error;
                }
                if (result.quantiles[q].error < qdata[q].min_e) {
                    qdata[q].min_e = result.quantiles[q].error;
                }
                qdata[q].sum_e += result.quantiles[q].error;

                // update actual info
                if (result.quantiles[q].actual > qdata[q].max_a) {
                    qdata[q].max_a = result.quantiles[q].actual;
                }
                if (result.quantiles[q].actual < qdata[q].min_a) {
                    qdata[q].min_a = result.quantiles[q].actual;
                }
                qdata[q].sum_a += result.quantiles[q].actual;

                // update prometheus info
                if (result.quantiles[q].prometheus > qdata[q].max_p) {
                    qdata[q].max_p = result.quantiles[q].prometheus;
                }
                if (result.quantiles[q].prometheus < qdata[q].min_p) {
                    qdata[q].min_p = result.quantiles[q].prometheus;
                }
                qdata[q].sum_p += result.quantiles[q].prometheus;
            }
        }
    }

    outputItems = [];
    console.error('#       /-------- ERROR --------\\     /------- ACTUAL -------\\      /----- PROMETHEUS -----\\');
    // Now go through and get the max/min/average error/actual/prometheus for each quantile.
    for (qidx = 0; qidx < quantiles.length; qidx++) {
        q = quantiles[qidx];
        outputItems.push({
            percentile: qToP(q),
            min_e: qdata[q].min_e,
            max_e: qdata[q].max_e,
            avg_e: +((qdata[q].sum_e / results.length).toFixed(2)),
            min_a: qdata[q].min_a,
            max_a: qdata[q].max_a,
            avg_a: +((qdata[q].sum_a / results.length).toFixed(2)),
            min_p: +(qdata[q].min_p.toFixed(3)),
            max_p: +(qdata[q].max_p.toFixed(3)),
            avg_p: +((qdata[q].sum_p / results.length).toFixed(2))
        });
    }
    tabula(outputItems, {
        columns: [
            {lookup: 'percentile', name: '%ILE', width: 6},
            {lookup: 'min_e', name: 'MIN%', width: 8},
            {lookup: 'max_e', name: 'MAX%', width: 8},
            {lookup: 'avg_e', name: 'AVG%', width: 8},
            {lookup: 'min_a', name: 'MIN', width: 8},
            {lookup: 'max_a', name: 'MAX', width: 8},
            {lookup: 'avg_a', name: 'AVG', width: 8},
            {lookup: 'min_p', name: 'MIN', width: 8},
            {lookup: 'max_p', name: 'MAX', width: 8},
            {lookup: 'avg_p', name: 'AVG', width: 8}
        ]
    });

    timeDelta = process.hrtime(startTime);
    elapsed = ((timeDelta[0] * 1e9 + timeDelta[1]) / 1e9);

    // Print a summary of how much data we processed.
    console.error('# data points: %d, chunk size: %d, chunks: %d, total elapsed (s): %d',
        count, CHUNK_SIZE, results.length, elapsed);
}


function main() {
    var buckets = [];
    var currentDataBox;
    var num;
    var rl;
    var results = [];

    prevStartTime = startTime;

    // Setup Buckets
    while (!Number.isNaN(num = Number(argv.pop()))) {
        buckets.unshift(num);
    }
    buckets.sort(function _sortBuckets(a, b) { return (a - b); });

    console.error('# BUCKETS: %s', JSON.stringify(buckets));
    console.error('# CHUNK_SIZE: %d', CHUNK_SIZE);

    // Create the first DataBox
    currentDataBox = new DataBox({buckets: buckets});

    // Read all the data
    rl = readline.createInterface({
        crlfDelay: Infinity,
        input: process.stdin,
        terminal: false
    });

    function processBox() {
        var result;

        console.error('# CHUNK %d', results.length);
        result = getResult(currentDataBox);
        result.elapsed = lapTime();
        results.push(result);

        // Now create a new box for the next chunk of data.
        currentDataBox = new DataBox({buckets: buckets});
    }

    rl.on('line', function _processLine(line) {
        var val = Number(line) / 1000; // input is a set of numbers in ms

        assert.number(val, '"' + val + '" should have been a number');

        currentDataBox.addDatum(val);
        if (currentDataBox.length() >= CHUNK_SIZE) {
            // Box is full, process result.
            processBox();
        }
    });

    // When we've read all the data, we'll actually calculate the results
    rl.on('close', function finalProcessing() {
        // Process the final Box
        processBox();
        outputResults(buckets, results);
    });
}


// Call main
main();
