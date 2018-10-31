/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

// Run with buckets as args and a file full of timestamps and numbers (one of
// each per line) on stdin.
//
// E.g.:
//
// node examples/error-estimator-rate.js 0.1 0.5 1 < myfile.txt
//
// Input should be sorted by time and look like:
//
//    ...
//    2018-09-01T00:00:00.935Z 154
//    2018-09-01T00:00:00.946Z 151
//    2018-09-01T00:00:01.196Z 179
//    2018-09-01T00:00:01.279Z 601
//    2018-09-01T00:00:01.308Z 2031
//    2018-09-01T00:00:01.351Z 129
//    ...
//
// IMPORTANT: This is very much a prototype, use at your own risk.
//

var readline = require('readline');

var assert = require('assert-plus');
var jsprim = require('jsprim');
var tabula = require('tabula');

var SAMPLE_FREQ = 15 * 1000; // ms
var VECTOR_SELECTOR = 300 * 1000; // ms

var argv = process.argv;
var startTime = process.hrtime();

// This holds the data very gently.
function DataBox(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.array(opts.buckets, 'opts.buckets');
    assert.ok(opts.buckets.length > 0, 'must have some buckets');

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

function getRealQuantile(q, data, isSorted) {
    assert.number(q, 'q');
    assert.array(data, 'data');
    assert.optionalBool(isSorted, 'isSorted');
    assert.ok(data.length > 0, 'must have data');
    assert.ok(q > 0 && q < 1, 'must have: 0 < q < 1');

    var idx;

    if (isSorted !== true) {
        data.sort(function _sortData(a, b) { return a - b; });
    }

    // Calculating the actual percentile is done by finding the index of the
    // percentile value * the number of elements. Since data is sorted, this
    // gives us the index of the value below which q*100 percent of the elements
    // are found.
    idx = Math.floor(q * data.length);

    // Need to subtract 1 because of 0 indexing for arrays, we want the "idx"th value.
    return (data[Math.max(0, idx - 1)]);
}

// See https://github.com/prometheus/prometheus/blob/c4a6acfb1e4f11244db3cbe8d777d249304a6ecf/promql/quantile.go#L49-L108
function getPrometheusQuantile(q, buckets, promData) {
    var b = -1;
    var bucketEnd;
    var bucketStart;
    var count;
    var idx;
    var rank;
    var value;

    assert.number(q, 'q');
    assert.ok(q > 0 && q < 1, 'must have: 0 < q < 1');
    assert.ok(buckets.length >= 2, 'must have at least 2 buckets');

    rank = promData['+Inf'] * q;

    // find the first bucket that's >= our rank value
    for (idx = 0; (b < 0) && (idx < buckets.length); idx++) {
        if (promData[buckets[idx]] >= rank) {
            b = idx;
        }
    }

    if (b === -1) {
        // The rank value is in +Inf, what prometheus does here is return the
        // largest bucket.
        return (buckets[buckets.length - 1]);
    } else if (b === 0 && buckets[0] <= 0) {
        // When the rank is in the first bucket, and the bucket value is <= 0,
        // return that bucket value.
        return (buckets[0]);
    } else {
        bucketStart = 0;
        bucketEnd = buckets[b];
        count = promData[buckets[b]];

        if (b > 0) {
            bucketStart = buckets[b - 1];
            count -= promData[buckets[b - 1]];
            rank -= promData[buckets[b - 1]];
        }

        value = bucketStart + (bucketEnd-bucketStart)*(rank/count);

        // For debugging, you can pass in a prometheus value and get some
        // additional information about how we generated that value.
        if (process.env.DEBUG_PROM_VALUE !== undefined
            && Number(process.env.DEBUG_PROM_VALUE) === +(value.toFixed(4))) {

            console.error('# bucketStart + (bucketEnd - bucketStart) * (rank / count) = value');
            console.error('# Returning %d + (%d - %d) * (%d / %d) = %d',
                bucketStart, bucketEnd, bucketStart, rank, count, value);
            console.log(JSON.stringify(promData, null, 2));
        }

        return (value);
    }
}

DataBox.prototype.length = function length() {
    var self = this;

    return (self.data.length);
};

DataBox.prototype.getPromData = function getPromData() {
    var self = this;

    return (jsprim.deepCopy(self.promData));
};


function qToP(q) {
    var pvalue;

    pvalue = 'P' + (+((q * 100).toFixed(5)));

    return (pvalue);
}

function extractValues(samples) {
    var idx;
    var sample;
    var values = [];

    for (idx = 0; idx < samples.length; idx++) {
        sample = samples[idx];
        values = values.concat(sample.values);
    }

    return (values);
}

function outputResults(buckets, count, results) {
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
    console.error('# data points: %d, chunks: %d, total elapsed (s): %d',
        count, results.length, elapsed);
}

// See: https://github.com/prometheus/prometheus/blob/f34b2602e1208b75dfa9ab17c81dd086fc92f54a/promql/functions.go#L60-L139
function calculateRates(opts, samples) {
    var averageDurationBetweenSamples;
    var bucket;
    var bucketIdx;
    var buckets;
    var durationToEnd;
    var durationToStart;
    var extrapolateToInterval;
    var extrapolationThreshold;
    var rangeEnd;
    var rangeStart;
    var results = {};
    var resultValue
    var sampledInterval;

    assert.object(opts, 'opts');
    assert.array(opts.buckets, 'opts.buckets');
    assert.number(opts.sampleEnd, 'opts.sampleEnd');

    if (samples.length < 2) {
        return {};
    }

    buckets = opts.buckets;
    rangeEnd = opts.sampleEnd;
    rangeStart = opts.sampleEnd - VECTOR_SELECTOR;

    durationToStart = samples[0].time - rangeStart;
    durationToEnd = rangeEnd - samples[samples.length - 1].time;
    sampledInterval = samples[samples.length - 1].time - samples[0].time;
    averageDurationBetweenSamples = sampledInterval / (samples.length - 1);
    extrapolationThreshold = averageDurationBetweenSamples * 1.1;
    extrapolateToInterval = sampledInterval;

    if (durationToStart < extrapolationThreshold) {
        extrapolateToInterval += durationToStart;
    } else {
        extrapolateToInterval += averageDurationBetweenSamples / 2;
    }
    if (durationToEnd < extrapolationThreshold) {
        extrapolateToInterval += durationToEnd;
    } else {
        extrapolateToInterval += averageDurationBetweenSamples / 2;
    }

    for (bucketIdx = 0; bucketIdx <= buckets.length; bucketIdx++) {
        if (bucketIdx === buckets.length) {
            bucket = '+Inf';
        } else {
            bucket = buckets[bucketIdx];
        }

        resultValue = samples[samples.length - 1][bucket] - samples[0][bucket];
        resultValue = resultValue * (extrapolateToInterval / sampledInterval);
        resultValue = resultValue / (VECTOR_SELECTOR / 1000);

        results[bucket] = resultValue;
    }

    return (results);
}

function calculateResult(buckets, samples, rates) {
    var actual;
    var idx;
    var prometheus;
    var q;
    var quantiles = [0.999, 0.99, 0.98, 0.95, 0.75, 0.50, 0.25];
    var rawValues;
    var result = {
        quantiles: {}
    };

    rawValues = extractValues(samples);

    for (idx = 0; idx < quantiles.length; idx++) {
        q = quantiles[idx];

        actual = getRealQuantile(q, rawValues);
        prometheus = getPrometheusQuantile(q, buckets, rates);

        if (process.env.DEBUG_PROM_VALUE !== undefined
            && Number(process.env.DEBUG_PROM_VALUE) === +(prometheus.toFixed(4))) {

            console.error('rawValues[%d]: %s', rawValues.length, JSON.stringify(rawValues, null, 2));
        }

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

function main() {
    var buckets = [];
    var count = 0;
    var dataBox;
    var num;
    var rl;
    var results = [];
    var sample;
    var samples = [];
    var sampleEnd;
    var sampleStart;
    var values = [];

    // Setup Buckets
    while (!Number.isNaN(num = Number(argv.pop()))) {
        buckets.unshift(num);
    }
    buckets.sort(function _sortBuckets(a, b) { return (a - b); });

    console.error('# BUCKETS: %s', JSON.stringify(buckets));

    // Create the first DataBox
    dataBox = new DataBox({
        buckets: buckets
    });

    // Read all the data
    rl = readline.createInterface({
        crlfDelay: Infinity,
        input: process.stdin,
        terminal: false
    });

    function processSample() {
        var rates;
        var result;

        rates = calculateRates({
            buckets: buckets,
            sampleEnd: sampleEnd
        }, samples);

        // If we didn't have enough samples (at least 2) calculateRates will
        // return an empty object. In that case, we can't process this sample.
        if (!rates.hasOwnProperty('+Inf')) {
            return;
        }

        result = calculateResult(buckets, samples, rates);

        results.push(result);
    }

    rl.on('line', function _processLine(line) {
        var chunks = line.split(' ');
        var time = new Date(chunks[0]).getTime();
        var val = Number(chunks[1]) / 1000; // input is a set of numbers in ms

        assert.equal(chunks.length, 2, 'should have 2 chunks, got: ' +
            JSON.stringify(chunks));
        assert.number(time, '"' + time + '" should have been a number');
        assert.number(val, '"' + val + '" should have been a number');

        count++;

        if (sampleStart === undefined) {
            sampleStart = time;
            sampleEnd = sampleStart + SAMPLE_FREQ;
        }

        while (time > sampleEnd) {
            console.error('# process chunk %s - %s: count: %d', 
                new Date(sampleStart).toISOString(),
                new Date(sampleEnd).toISOString(),
                count);

            sample = dataBox.getPromData();
            sample.time = sampleEnd;
            sample.values = values;
            values = [];
            samples.push(sample);

            if (samples.length > (300000 / SAMPLE_FREQ)) {
                samples.shift();
                processSample();
            }

            sampleStart += SAMPLE_FREQ;
            sampleEnd += SAMPLE_FREQ;
        }

        values.push(val);
        dataBox.addDatum(val);
    });

    // When we've read all the data, we'll actually calculate the results
    rl.on('close', function finalProcessing() {
        // Process the final samples
        processSample();
        outputResults(buckets, count, results);
    });
}


// Call main
main();
