/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * test helpers
 */

/*
 * The metrics endpoint returns metrics in the Prometheus v0.0.4 format.
 * This function takes the metrics response and a metric to match the metric
 * line you want to match as input and returns the count of that metric.
 * If node-artedi#11 (could provide a reverse serializer) is implemented,
 * this function should be changed to use that.
 */
function getMetricCount(metricsRes, labels) {
    var metricsLines = metricsRes.split('\n');
    var metricLine = metricsLines.filter(function(line) {
        var match = true;
        labels.forEach(function(label) {
            var lineMatch = line.indexOf(label);
            if (lineMatch === -1) {
                match = false;
            }
        });

        return match;
    });
    var count = Number(metricLine[0].split('} ')[1]);
    return count;
}

module.exports = {
    getMetricCount: getMetricCount
};
