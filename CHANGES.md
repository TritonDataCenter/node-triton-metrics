# node-triton-metrics Changelog

## not yet released

(nothing yet)

## 1.0.0

- Switch to artedi-v2.
- Redo how buckets work for histograms. Now have node-triton-metrics default
  buckets which can be overridden by caller.
- Expose bucket generator functions on MetricsManager objects.

## 0.4.0

- Add support for metricsManager to listen on a socket. A socket path can be specified
  via the options.path property passed to `createMetricsManager`.

## 0.3.1

- Fix missing "gc-stats" dependency in package.json

## 0.3.0

- Add support for `metricsManager.collectNodejsMetrics()` which will collect a
  number of metrics about the node process including: eventloop time and lag,
  memory and CPU counters, V8 heap statistics, garbage collection, and process
  start time.

## 0.2.0

- Add support for `metricsManager.addPreCollectFunc(function (callback))` which
  allows setting/observing metrics just before the artedi collector's collect
  function is run.

## 0.1.1

- Change restify peer dependency to 4.x

## 0.1.0

(first version)
