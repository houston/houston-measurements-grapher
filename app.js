var FileStreamRotator = require('file-stream-rotator')
var express = require('express');
var morgan = require('morgan');
var path = require('path');

var app = express();
var logDirectory = path.join(__dirname, 'log');

// create a rotating write stream
var accessLogStream = FileStreamRotator.getStream({
  date_format: 'YYYYMMDD',
  filename: path.join(logDirectory, 'access-%DATE%.log'),
  frequency: 'daily',
  verbose: false
});

// setup the logger
app.use(morgan('combined', { stream: accessLogStream }));

var pgp = require('pg-promise')(/*options*/);                                   // <-- TODO: what options?
var db = pgp(process.env.HOUSTON_DATABASE_URL);

var jsdom = require('jsdom').jsdom;
var canvg = require('canvg');
var d3 = require('d3');

var graphLine = require("./line");
var getTickFormat = require("./utils");

var SUBJECT_TYPES = { 'p': 'Project', 'u': 'User' };

function parseParams(params) {
  var now = new Date();
  var oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  var queryOptions = { startTime: oneMonthAgo, endTime: now },
      graphOptions = { width: 342, height: 102 };

  for(var key in params) {
    var value = params[key];
    switch(key) {
      // Query Options
      case 'n': queryOptions.measurements = value.split(';'); break;
      case 't': queryOptions.subjectType = SUBJECT_TYPES[value]; break;
      case 'p': queryOptions.projects = value.split(','); break;
      case 's': queryOptions.startTime = new Date(value * 1000); break;
      case 'e': queryOptions.endTime = new Date(value * 1000); break;

      // Graph Options
      case 'l': graphOptions.min = +value; break;
      case 'u': graphOptions.max = +value; break;
      case 'w': graphOptions.width = +value; break;
      case 'h': graphOptions.height = +value; break;

      default: console.log(`Unrecognized param: ${key}`); break;
    }
  }

  return { queryOptions: queryOptions, graphOptions: graphOptions };
}

// changes BASH-style options `daily.hours.charged.{development,ix-design}`
// to options for SIMILAR TO `(daily.hours.charged.(development|ix-design))`
// also changes BASH-style match-all `*` to `%`
function toNamePattern(names) {
  return `(${names.map(function(pattern) {
    return pattern.replace(/\{([\w\-,]+)\}/g, function($0, $1) {
      return `(${$1.replace(',', '|')})`;
    }).replace('*', '%');
  }).join('|')})`;
}

function toQuery(options) {
  var queryParams = {
        namePattern: toNamePattern(options.measurements),
        startTime: options.startTime,
        endTime: options.endTime
      },
      clauses = [
        'measurements.name similar to ${namePattern}',
        'measurements.taken_at between ${startTime} and ${endTime}'
      ],
      query = 'select measurements.taken_at "timestamp", measurements.name, measurements.value from measurements';

  if(options.subjectType) {
    clauses.push(`measurements.subject_type='${options.subjectType}'`);
  }

  if(options.projects) {
    query = `${query} inner join projects on measurements.subject_type='Project' and measurements.subject_id=projects.id`;
    queryParams.projects = options.projects;
    clauses.push('projects.slug = ANY(${projects})');
  }

  query = `${query} where ${clauses.join(' and ')} order by taken_at desc`;

  return { query: query, queryParams: queryParams };
}

app.get('/line.png', function (req, res) {
  var ref1 = parseParams(req.query),
      queryOptions = ref1.queryOptions,
      graphOptions = ref1.graphOptions,
      ref2 = toQuery(queryOptions),
      query = ref2.query,
      queryParams = ref2.queryParams;
  console.log('queryOptions', queryOptions);                                    // <-- TODO: for debugging
  console.log('graphOptions', graphOptions);                                    // <-- TODO: for debugging
  console.log('query', query);                                                  // <-- TODO: for debugging
  console.log('queryParams', queryParams);                                      // <-- TODO: for debugging

  db.query(query, queryParams).then(function(data) {


    var dom = jsdom('<html><body></body></html>');
    var window = dom.defaultView;
    graphLine({
      selector: window.document.body,
      tickFormat: getTickFormat(graphOptions),
      data: data,
      width: graphOptions.width,
      height: graphOptions.height,
      min: graphOptions.min,
      max: graphOptions.max
    });

    // Apply D3's default CSS
    d3.select(window.document.body).selectAll('path.domain').style('display', 'none');
    d3.select(window.document.body).selectAll('.axis line')
      .style('fill', 'none')
      .style('stroke', '#ddd')
      .style('shape-rendering', 'crispEdges');
    d3.select(window.document.body).selectAll('.axis text')
      .style('fill', '#999')
      .style('font-size', '11px');
    var svg = window.document.body.innerHTML;

    // Renders SVG XML onto a Canvas
    // https://github.com/canvg/canvg
    var canvas = window.document.createElement('canvas');
    canvas.setAttribute('width', graphOptions.width * 2);
    canvas.setAttribute('height', graphOptions.height * 2);
    canvg(canvas, svg, {
      ignoreDimensions: true,
      scaleWidth: graphOptions.width * 2,
      scaleHeight: graphOptions.height * 2
    });

    // Canvas exports a PNG data: URI at 96DPI
    var png = canvas.toDataURL().substr(22);
    var buffer = new Buffer(png, 'base64'); // change from `new Buffer` to `Buffer.from` in Node 6+
    res.contentType('image/png');
    res.end(buffer);


  }).catch(function(error) {
    console.log('error', error);
  });
});

app.listen(3000, function () {
  console.log('houston-measurements-grapher listening on port 3000!');
});
