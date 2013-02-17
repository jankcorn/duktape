/*
 *  Test case runner.
 *
 *  Error handling is currently not correct throughout.
 */

var fs = require('fs'),
    path = require('path'),
//    temp = require('temp'),
    child_process = require('child_process'),
    async = require('async'),
    xml2js = require('xml2js'),
    md5 = require('MD5');

var TIMEOUT_SLOW = 300 * 1000
var TIMEOUT_NORMAL = 120 * 1000;

/*
 *  Utils.
 */

// FIXME: placeholder; for some reason 'temp' didn't work
var tmpCount = 0;
function mkTempName() {
    return '/tmp/runtests-' + (++tmpCount);
}

function safeUnlinkSync(filePath) {
    try {
        if (filePath) {
            fs.unlink(filePath);
        }
    } catch (e) {
        console.log('Failed to unlink ' + filePath + ' (ignoring): ' + e);
    }
}

function safeReadFileSync(filePath, encoding) {
    try {
        if (!filePath) {
            return;
        }
        return fs.readFileSync(filePath, encoding);
    } catch (e) {
        console.log('Failed to read ' + filePath + ' (ignoring): ' + e);
    }
}

function diffText(text1, text2, callback) {
    var tmp1 = mkTempName();
    var tmp2 = mkTempName();
    var cmd;

    fs.writeFileSync(tmp1, text1);
    fs.writeFileSync(tmp2, text2);
    cmd = [ 'diff', '-u', tmp1, tmp2 ];
    child = child_process.exec(cmd.join(' '), function diffDone(error, stdout, stderr) {
        safeUnlinkSync(tmp1);
        safeUnlinkSync(tmp2);
        callback(null, stdout);
    });
}

/*
 *  Parse a testcase file.
 */

function parseTestCaseSync(filePath) {
    var text = fs.readFileSync(filePath, 'utf-8');
    var pos, i1, i2;
    var meta = {};
    var tmp;
    var expect = '';

    i1 = text.indexOf('/*---'); i2 = text.indexOf('---*/');
    if (i1 >= 0 && i2 >= 0 && i2 >= i1) {
        meta = JSON.parse(text.substring(i1 + 5, i2));
    }

    pos = 0;
    for (;;) {
        i1 = text.indexOf('/*===', pos); i2 = text.indexOf('===*/', pos);
        if (i1 >= 0 && i2 >= 0 && i2 >= i1) {
            pos = i2 + 5;
            tmp = text.substring(i1 + 5, i2).split('\n').slice(1, -1);  // ignore first and last line
            expect += tmp.map(function (x) { return x + '\n'; }).join('');
        } else {
            break;
        }
    }

    return {
        filePath: filePath,
        name: path.basename(filePath, '.js'),
        meta: meta,
        expect: expect,
        expect_md5: md5(expect)
    };
}

/*
 *  Execute a testcase with a certain engine, with optional valgrinding.
 */

function executeTest(options, callback) {
    var child;
    var cmd, cmdline;
    var execopts;
    var tempInput, tempVgxml, tempVgout;

    function execDone(error, stdout, stderr) {
        var res;

        res = {
            testcase: options.testcase,
            engine: options.engine,
            error: error,
            stdout: stdout,
            stderr: stderr,
            cmdline: cmdline
        };

        res.valgrind_xml = safeReadFileSync(tempVgxml, 'utf-8');
        res.valgrind_out = safeReadFileSync(tempVgout, 'utf-8');

        safeUnlinkSync(tempInput);
        safeUnlinkSync(tempVgxml);
        safeUnlinkSync(tempVgout);

        if (res.valgrind_xml &&
            res.valgrind_xml.substring(0, 5) === '<?xml' &&
            res.valgrind_xml.indexOf('</valgrindoutput>') > 0) {
            /* FIXME: Xml2js seems to not throw an error nor call the callback
             * in some cases (e.g. when a child is killed and xml output is
             * incomplete).  So, use a simple pre-check to guard against parsing
             * trivially broken XML.
             */
            try {
               xml2js.parseString(res.valgrind_xml, function (err, result) {
                    if (err) {
                        console.log(err);
                    } else {
                        res.valgrind_root = result;
                        res.valgring_json = JSON.stringify(result);
                    }
                    callback(null, res);
                });
            } catch (e) {
                console.log('xml2js parsing failed, should not happen: ' + e);
                callback(null, res);
            }
        } else {
            callback(null, res);
        }
    }

    if (options.engine.jsPrefix) {
        // doesn't work
        // tempInput = temp.path({ prefix: 'runtests-', suffix: '.js'})
        tempInput = mkTempName();
        try {
            fs.writeFileSync(tempInput, options.engine.jsPrefix + fs.readFileSync(options.testPath));
        } catch (e) {
            console.log(e);
            callback(e);
            return;
        }
    }

    /* FIXME: use child_process.spawn(); we don't currently escape command
     * line parameters which is risky.
     */
    cmd = [];
    if (options.valgrind) {
        tempVgxml = mkTempName();
        tempVgout = mkTempName();
        cmd = cmd.concat([ 'valgrind', '--tool=memcheck', '--xml=yes',
                           '--xml-file=' + tempVgxml,
                           '--log-file=' + tempVgout,
                           '--child-silent-after-fork=yes', '-q' ]);
    }
    cmd.push(options.engine.fullPath);
    if (options.valgrind && options.engine.name === 'duk') {
        cmd.push('-m');  // higher memory limit
    }
    cmd.push(tempInput || options.testPath);
    cmdline = cmd.join(' ');

    execopts = {
        maxBuffer: 128 * 1024 * 1024,
        timeout: options.testcase.meta.slow || options.valgrind ? TIMEOUT_SLOW : TIMEOUT_NORMAL,
        stdio: 'pipe'
    };

    child = child_process.exec(cmdline, execopts, execDone);
}

/*
 *  Main
 */

var NODEJS_HEADER =
    "/* nodejs header begin */\n" +
    "function print() {\n" +
    "    // Note: Array.prototype.map() is required to support 'this' binding\n" +
    "    // other than an array (arguments object here).\n" +
    "    var tmp = Array.prototype.map.call(arguments, function (x) { return String(x); });\n" +
    "    var msg = tmp.join(' ') + '\\n';\n" +
    "    process.stdout.write(msg);\n" +
    "}\n" +
    "/* nodejs header end */\n" +
    "\n";

function findTestCasesSync(argList) {
    var found = {};
    var pat = /^([a-zA-Z0-9_-]+).js$/;
    var testcases = [];

    argList.forEach(function checkArg(arg) {
        var st = fs.statSync(arg);
        var m;

        if (st.isFile()) {
            m = pat.exec(path.basename(arg));
            if (!m) { return; }
            if (found[m[1]]) { return; }
            found[m[1]] = true;
            testcases.push(arg);
        } else if (st.isDirectory()) {
            fs.readdirSync(arg)
              .forEach(function check(fn) {
                  var m = pat.exec(fn);
                  if (!m) { return; }
                  if (found[m[1]]) { return; }
                  found[m[1]] = true;
                  testcases.push(path.join(arg, fn));
              });
        } else {
            throw new Exception('invalid argument: ' + arg);
        }
    });

    return testcases;
}

function adornString(x) {
    var stars = '********************************************************************************';
    return stars.substring(0, x.length + 8) + '\n' +
           '*** ' + x + ' ***' + '\n' +
           stars.substring(0, x.length + 8);
}

function prettyJson(x) {
    return JSON.stringify(x, null, 2);
}

function prettySnippet(x, label) {
    x = (x != null ? x : '');
    if (x.length > 0 && x[x.length - 1] != '\n') {
        x += '\n';
    }
    return '=== begin: ' + label + ' ===\n' +
           x +
           '=== end: ' + label + ' ===';
}

function getValgrindErrorSummary(root) {
    var res;
    var errors;

    if (!root || !root.valgrindoutput || !root.valgrindoutput.error) {
        return;
    }

    root.valgrindoutput.error.forEach(function vgError(e) {
        var k = e.kind[0];
        if (!res) {
            res = {};
        }
        if (!res[k]) {
            res[k] = 1;
        } else {
            res[k]++;
        }
    });

    return res;
}

function testRunnerMain() {
    // FIXME: proper arg help
    var argv = require('optimist')
        .usage('Execute one or multiple test cases; dirname to execute all tests in a directory.')
        .default('num-threads', 4)
        .boolean('run-duk')
        .boolean('run-nodejs')
        .boolean('run-rhino')
        .boolean('run-smjs')
        .boolean('verbose')
        .boolean('report-diff-to-other')
        .boolean('valgrind')
        .demand(1)   // at least 1 non-arg
        .argv;
    var testcases;
    var engines;
    var queue1, queue2;
    var results = {};  // testcase -> engine -> result
    var execStartTime, execStartQueue;

    function iterateResults(callback, filter_engname) {
        var testname, engname;

        for (testname in results) {
            for (engname in results[testname]) {
                if (filter_engname && engname !== filter_engname) {
                    continue;
                }
                res = results[testname][engname];
                callback(testname, engname, results[testname][engname]);
            }
        }
    }

    function queueExecTasks() {
        var tasks = [];

        testcases.forEach(function test(fullPath) {
            var filename = path.basename(fullPath);
            var testcase = parseTestCaseSync(fullPath);

            results[testcase.name] = {};  // create in test case order

            engines.forEach(function testWithEngine(engine) {
                tasks.push({
                    engine: engine,
                    filename: filename,
                    testPath: fullPath,
                    testcase: testcase,
                    valgrind: argv.valgrind && (engine.name === 'duk')
                });
            });
        });

        if (tasks.length === 0) {
            console.log('No tasks to execute');
            process.exit(1);
        }

        console.log('Executing ' + testcases.length + ' testcase(s) with ' +
                    engines.length + ' engine(s) using ' + argv['num-threads'] + ' threads' +
                    ', total ' + tasks.length + ' task(s)' +
                    (argv.valgrind ? ', valgrind enabled (for duk)' : ''));

        queue1.push(tasks);
    }

    function queueDiffTasks() {
        var tn, en, res;

        console.log('Testcase execution done, running diffs');

        iterateResults(function queueDiff(tn, en, res) {
            if (res.stdout !== res.testcase.expect) {
                queue2.push({
                    src: res.testcase.expect,
                    dst: res.stdout,
                    resultObject: res,
                    resultKey: 'diff_expect'
                });
            }
            if (en !== 'duk') {
                return;
            }

            // duk-specific diffs
            engines.forEach(function diffToEngine(other) {
                if (other.name === 'duk') {
                    return;
                }
                if (results[tn][other.name].stdout === res.stdout) {
                    return;
                }
                if (!res.diff_other) {
                    res.diff_other = {}
                }
                queue2.push({
                    src: res.stdout,
                    dst: results[tn][other.name].stdout,
                    resultObject: res.diff_other,
                    resultKey: other.name
                });
            });
        }, null);
    }

    function analyzeResults() {
        iterateResults(function analyze(tn, en, res) {
            res.stdout_md5 = md5(res.stdout);
            res.stderr_md5 = md5(res.stderr);

            if (res.testcase.meta.skip) {
                res.status = 'skip';
            } else if (res.diff_expect) {
                res.status = 'fail';
            } else {
                res.status = 'pass';
            }
        });
    }

    function printSummary() {
        var countPass = 0, countFail = 0, countSkip = 0;
        var lines = [];

        iterateResults(function summary(tn, en, res) {
            var parts = [];
            var diffs;
            var vgerrors;
            var need = false;

            vgerrors = getValgrindErrorSummary(res.valgrind_root);

            parts.push(res.testcase.name);
            parts.push(res.status);

            if (res.status === 'skip') {
                countSkip++;
            } else if (res.status === 'fail') {
                countFail++;
                parts.push(res.diff_expect.split('\n').length + ' diff lines');
                need = true;
            } else {
                countPass++;

                diffs = [];

                engines.forEach(function checkDiffToOther(other) {
                    if (other.name === 'duk' ||
                        !res.diff_other || !res.diff_other[other.name]) {
                        return;
                    }
                    parts.push(other.name + ' diff ' + res.diff_other[other.name].split('\n').length + ' lines');
                    if (argv['report-diff-to-other']) {
                        need = true;
                    }
                });
           }
           if (vgerrors) {
               parts.push('valgrind ' + JSON.stringify(vgerrors));
               need = true;
           }
           if (need) { 
               lines.push(parts);
           }
        }, 'duk');

        lines.forEach(function printLine(line) {
            var tmp = ('                                                  ' + line[0]);
            tmp = tmp.substring(tmp.length - 50);
            console.log(tmp + ': ' + line.slice(1).join('; '));
        });

        console.log('');
        console.log('SUMMARY: ' + countPass + ' pass, ' + countFail +
                    ' fail, ' + countSkip + ' skip');
    }

    function createLogFile(logFile) {
        var lines = [];

        iterateResults(function logResult(tn, en, res) {
            var desc = tn + '/' + en;
            lines.push(adornString(tn + ' ' + en));
            lines.push('');
            lines.push(prettyJson(res));
            lines.push('');
            lines.push(prettySnippet(res.stdout, 'stdout of ' + desc));
            lines.push('');
            lines.push(prettySnippet(res.stderr, 'stderr of ' + desc));
            lines.push('');
            lines.push(prettySnippet(res.testcase.expect, 'expect of ' + desc));
            lines.push('');
            if (res.diff_expect) {
                lines.push(prettySnippet(res.diff_expect, 'diff_expect of ' + desc));
                lines.push('');
            }
            if (res.diff_other) {
                for (other_name in res.diff_other) {
                    lines.push(prettySnippet(res.diff_other[other_name], 'diff_other ' + other_name + ' of ' + desc));
                    lines.push('');
                }
            }
        });

        fs.writeFileSync(logFile, lines.join('\n') + '\n');
    }

    engines = [];
    if (argv['run-duk']) {
        engines.push({ name: 'duk', fullPath: argv['cmd-duk'] || 'duk' });
    }
    if (argv['run-nodejs']) {
        engines.push({ name: 'nodejs', fullPath: argv['cmd-nodejs'] || 'node', jsPrefix: NODEJS_HEADER });
    }
    if (argv['run-rhino']) {
        engines.push({ name: 'rhino', fullPath: argv['cmd-rhino'] || 'rhino' });
    }
    if (argv['run-smjs']) {
        engines.push({ name: 'smjs',  fullPath: argv['cmd-smjs'] || 'smjs' });
    }

    testcases = findTestCasesSync(argv._);
    testcases.sort();

    queue1 = async.queue(function (task, callback) {
        executeTest(task, function testDone(err, val) {
            var tmp;
            results[task.testcase.name][task.engine.name] = val;
            if (argv.verbose) {
                tmp = '        ' + task.engine.name + (task.valgrind ? '/vg' : '');
                console.log(tmp.substring(tmp.length - 8) + ': ' + task.testcase.name);
            }
            callback();
        });
    }, argv['num-threads']);

    queue2 = async.queue(function (task, callback) {
        if (task.dummy) {
            callback();
            return;
        }
        diffText(task.src, task.dst, function (err, val) {
            task.resultObject[task.resultKey] = val;
            callback();
        });
    }, argv['num-threads']);

    queue1.drain = function() {
        // Second parallel step: run diffs
        queue2.push({ dummy: true });  // ensure queue is not empty
        queueDiffTasks();
    };

    queue2.drain = function() {
        // summary and exit
        analyzeResults();
        console.log('\n----------------------------------------------------------------------------\n');
        printSummary();
        console.log('\n----------------------------------------------------------------------------\n');
        if (argv['log-file']) {
            console.log('Writing test output to: ' + argv['log-file']);
            createLogFile(argv['log-file']);
        }
        console.log('All done.');
        process.exit(0);
    };

    // First parallel step: run testcases with selected engines
    queueExecTasks();

    // Periodic indication of how much to go
    execStartTime = new Date().getTime();
    execStartQueue = queue1.length();
    var timer = setInterval(function () {
        // not exact; not in queued != finished
        var now = new Date().getTime();
        var rate = (execStartQueue - queue1.length()) / ((now - execStartTime) / 1000);
        var eta = Math.ceil(queue1.length() / rate);
        console.log('Still running, testcase task queue length: ' + queue1.length() + ', eta ' + eta + ' second(s)');
    }, 10000);
}

testRunnerMain();

