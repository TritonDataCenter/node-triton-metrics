# node-triton-metrics

This library provides a metrics manager to aid in collecting and exposing Triton service metrics.
It unifies the metric collection library, [artedi](https://github.com/joyent/node-artedi), 
and a Restify server that exposes those metrics in the [Prometheus](https://prometheus.io/) format.

# Install

```
npm install triton-metrics
```

# Examples

This library has only been tested with Restify 4.x, but may work with other versions.

Create the `MetricsManager` object:
```js
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify') // This has only been tested with Restify 4.x

var metricsManager = createMetricsManager({
    address: config.address,
    log: config.log,
    staticLabels: {
        datacenter: config.datacenter,
        instance: config.instanceUuid,
        server: config.serverUuid,
        service: config.serviceName
    },
    port: config.port,
    restify: restify
});

```
Start the metrics server:
```js
metricsManager.listen(callback);
```
If you are measuring a restify server, a helper is provided to add restify related collectors to the `MetricsManager`:

```js
metricsManager.createRestifyMetrics();
```
These restify collectors include a counter that counts requests completed and a histogram that collects the time to process requests.
These metrics can be collected in the "after" hook of a restify server:
```js
var server = require('restify').createServer();
server.on('after', metricsManager.collectRestifyMetrics.bind(metricsManager));
```
To create custom collectors, add them to `MetricsManager#collector` according to the [artedi API](https://github.com/joyent/node-artedi/blob/master/docs/API.md):
```js
metricsManager.collector.counter({
    name: 'foo',
    help: 'foo help'
});

var labels = {
    bar: 'baz'
}

metricsManager.collector.getCollector('foo').increment(labels);

// or

counter.increment(labels);
```
In addition, metrics can be added to groups and can be collected with a user defined function:
```js
var counter = metricsManager.collector.counter({
    name: 'foo',
    help: 'foo help'
});

var histogram = metricsManager.collector.histogram({
    name: 'bar',
    help: 'bar help'
});

var collectMetrics = function(baz, num) {
    var labels = {
        baz: baz
    }

    counter.increment(labels);
    histogram.observe(num, labels);
}

metricsManager.createMetrics('arbitraryGroup', collectMetrics);
metricsManager.collectMetrics('arbitraryGroup', 'test', 42);
```
The server exposes a /metrics endpoint which returns the metrics in the Prometheus [v0.0.4 format](https://github.com/prometheus/docs/blob/master/content/docs/instrumenting/exposition_formats.md#format-version-004).

Example curl of the /metrics endpoint:

```shell
$ curl http://<address>:<port>/metrics

# HELP http_requests_completed count of requests completed
# TYPE http_requests_completed counter
http_requests_completed{route="getconfigs",method="GET",user_agent="restify/2.8.5",status_code="304",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi"} 1
http_requests_completed{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi"} 1
# HELP http_request_duration_seconds total time to process requests
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.01"} 0
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.02"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.03"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.04"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.05"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.06"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.07"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.08"} 1
http_request_duration_seconds{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi",le="0.09"} 1
http_request_duration_seconds{le="+Inf",route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi"} 1
http_request_duration_seconds_count{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi"} 1
http_request_duration_seconds_sum{route="ping",method="GET",user_agent="curl/7.47.0",status_code="200",datacenter="coal",instance="83c07804-0ecf-460a-8cad-5b8b1cdbe1bc",server="564dc035-64a5-6420-88ce-59e1d1fbe100",service="sapi"} 0.011
```

# Usage

#### `createMetricsManager(options)`
Accepts an options object and returns a new `MetricsManager` object.

* `options` -- Object. All options are required unless noted otherwise.
    * `log`: A [bunyan](https://github.com/trentm/node-bunyan) logger.
    * `restify`: Restify library. Support is only guaranteed for version 4.x.
    * `staticLabels`: An object that includes labels to be attached to every collector.
        * `datacenter`: String, datacenter name.
        * `instance`: String, instance UUID.
        * `port`: Number, optional, metrics server port. Helpful when multiple instances of a service are running in the same zone.
        * `server`: String, server UUID.
        * `service`: String, service name.
    * `metricOpts`: An object containing additional labels and/or buckets for the specified metrics. Keys must be metric names, values are objects with:
        * `buckets`: Array of numbers (buckets), only used for histograms
        * `labels`: Object containing additional labels (key: value) that will be added for this specific metric.
    * `address`: String, required if port is defined, the metrics server address.
    * `path`: String, required if port is not defined, the metrics server socket path.
    * `port`: Number, required if path is not defined, the metrics server port number.

#### `MetricsManager.listen(callback)`
Starts the metrics server.

Parameters
* callback -- Function to run after the server has started

#### `MetricsManager.close(callback)`
Stops the metrics server.

Parameters
* callback -- Function to run after the server has stopped.

#### `MetricsManager.createMetrics(name, collectMetrics)`
Creates a group of metrics.

Parameters
* name -- String, a name to reference the metrics group.
* collectMetrics -- Function, accepts an arbitrary number of arguments and handles metric collection for the metrics group.

#### `MetricsManager.collectMetrics(name, ...args)`
Collects metrics for a metrics group.

Parameters
* name -- String, the name of the metrics group.
* ...args -- An arbitrary number of arguments to be passed to the `collectMetrics` function specified in `createMetrics`.

#### `MetricsManager.createNodejsMetrics()`

Important: These metrics are considered experimental/uncommitted. The specific
metrics exposed are expected to change without separate notice. Do not be
surprised if you build things relying on this data when some keys disappear in a
future version, keys are renamed, or new metrics are added.

Running this function adds several metrics indicating internal state of the node
process. These include currently:

* nodejs_V8_heap_size_executable_bytes
* nodejs_V8_heap_size_limit_bytes
* nodejs_V8_total_available_size_bytes
* nodejs_V8_total_heap_size_bytes
* nodejs_V8_total_physical_size_bytes
* nodejs_V8_used_heap_size_bytes
* nodejs_active_handles_count
* nodejs_active_requests_count
* nodejs_eventloop_lag_seconds_total
* nodejs_eventloop_max_lag_seconds
* nodejs_eventloop_max_tick_count
* nodejs_eventloop_max_time_seconds
* nodejs_eventloop_min_lag_seconds
* nodejs_eventloop_min_tick_count
* nodejs_eventloop_min_time_seconds
* nodejs_eventloop_samples_total
* nodejs_eventloop_tick_count_total
* nodejs_eventloop_time_seconds_total
* nodejs_gc_execution_count_total
* nodejs_gc_pause_seconds_total
* nodejs_memory_external_bytes
* nodejs_memory_heapTotal_bytes
* nodejs_memory_heapUsed_bytes
* nodejs_memory_rss_bytes
* nodejs_process_start_time_seconds
* nodejs_system_cpu_seconds_total
* nodejs_user_cpu_seconds_total

#### `MetricsManager.createRestifyMetrics()`
Adds a `restify` metrics group that includes common metrics to be collected from a Restify server -- a [counter](lib/metrics-manager.js#L119) to track http requests and a [histogram](lib/metrics-manager.js#L124) to track the time to process requests

#### `MetricsManager.collectRestifyMetrics(req, res, route)`
Collects `restify` metrics. Typically called in the "after" hook of a restify server.

Parameters
* req -- Restify request object.
* res -- Restify response object.
* route -- Restify route object.

These collectors collect the following metrics
* http_requests_completed
* http_request_duration_seconds

Both metrics add the following labels:
* method (e.g. 'PUT')
* status_code (e.g. 200)
* route (e.g. 'listvms')
* user_agent (only the first token e.g. restify/1.5.2) 

#### `MetricsManager.addPreCollectFunc(function (callback))`

Adds a function with the signature `function (callback)` to the list of
functions that will be called just before collecting the metrics. This is
intended to be used for things like `gauge.set(value)` to set a value just
before collection in cases where setting the value constantly might be otherwise
expensive.

The function provided *must* call callback() when completed *with no arguments*.

#### `MetricsManager#collector`
Artedi collector. Each metric needs to be added to this collector

#### `MetricsManager.linearBuckets(min, width, count)`

This is just exposing the node artedi bucket generator function. See: [https://github.com/joyent/node-artedi/blob/master/docs/API.md#bucket-generators](https://github.com/joyent/node-artedi/blob/master/docs/API.md#bucket-generators)

#### `MetricsManager.exponentialBuckets(min, factor, count)`

This is just exposing the node artedi bucket generator function. See: [https://github.com/joyent/node-artedi/blob/master/docs/API.md#bucket-generators](https://github.com/joyent/node-artedi/blob/master/docs/API.md#bucket-generators)

#### `MetricsManager.logLinearBuckets(base, lowPower, highPower, bucketsPerMagnitude)`

This is just exposing the node artedi bucket generator function. See: [https://github.com/joyent/node-artedi/blob/master/docs/API.md#bucket-generators](https://github.com/joyent/node-artedi/blob/master/docs/API.md#bucket-generators)

# Histogram buckets and versioning

It is expected that if you are adding custom buckets in your application, you'll
want to eventually also be able to change those buckets. In order to do this it
is recommended that you do something like:

```
metricsManager = tritonMetrics.createMetricsManager({
    ...
    metricOpts: {
        http_request_duration_seconds: {
            buckets: [1, 2, 3, 4],
            labels: {
                buckets_version: 1
            }
        }
    },
    ...
});
```

when setting the buckets for your histogram. Then you should increment the
`buckets_version` value every time you change your buckets. This way, you can
write your queries for prometheus as:

```
histogram_quantile(0.95, sum(rate(http_request_duration_seconds{buckets_version="1"}[5m])) by (le))
```

and in doing so you can be sure that you're always doing a quantile on the same
buckets. When you introduce `buckets_version="2"` you can then add this as a
separate query on your graphs (each instance will only have data for one or the
other) and you will not need to delete all old data in the prometheus store but
will still avoid the problems discussed in
[node-artedi#17](https://github.com/joyent/node-artedi/pull/17).

# Development

There is automated code formatting (using `eslint --fix` and `prettier`):

    make fmt

There is lint/style checking (using `eslint` and `prettier --list-different`):

    make check

Please be sure to run all of the above prior to submitting changes. One
easy way to remember that is to run the following once for a clone to run
them automatically prior to `git commit`:

    make git-hooks

To run the test suite:

    make test
