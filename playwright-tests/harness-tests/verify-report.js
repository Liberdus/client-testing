const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class DiagnosticsReport {
  static verify() {
    const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-results/diagnostics-report.json'), 'utf8'));
    const specs = report.suites.flatMap(suite => [...suite.specs, ...suite.suites.flatMap(child => child.specs)]);
    const cases = specs.flatMap(spec => spec.tests);
    const flaky = cases.find(test => test.results.length === 2 && test.results[0].status === 'failed');
    assert(flaky, 'Expected controlled attempt-zero failure');
    assert.equal(flaky.results[1].status, 'passed');
    const failed = flaky.results[0];
    const trace = failed.attachments.find(item => item.name === 'trace');
    assert(trace && fs.statSync(trace.path).size > 0, 'Failed initial attempt must retain a trace');
    const attachment = failed.attachments.find(item => item.name === 'failure-diagnostics');
    const evidence = JSON.parse(attachment.body ? Buffer.from(attachment.body, 'base64').toString() : fs.readFileSync(attachment.path, 'utf8'));
    assert.equal(evidence.retry, 0);
    assert(evidence.requests.some(item => item.status === 503 && item.outcome === 'http-error'));
    assert(evidence.errors.some(item => item.text === 'popup diagnostic marker'));
    assert(evidence.captures.some(item => item.stage === 'recipient-before-close' && item.identity.username === 'recipient'));
    assert(failed.attachments.some(item => item.name.includes('recipient-before-close') && item.contentType === 'image/png'));
    assert(!JSON.stringify(evidence).includes('DO_NOT_CAPTURE'));
    const hook = cases.find(test => test.results[0].error?.message.includes('hookrecipient'));
    assert(hook, 'Expected failed beforeAll registration evidence');
    assert.equal(hook.results[1].status, 'passed');
    assert(hook.results[0].error.message.includes('registration-confirmation'));
    assert(hook.results[0].attachments.some(item => item.name === 'account-setup-failure'));
    assert(hook.results[0].attachments.some(item => item.name === 'cleanup-diagnostics'));
    assert.equal(report.stats.unexpected, 0);
    console.log('Verified failed-attempt trace, HTTP evidence, popup errors, redaction and pre-close recipient screenshot.');
  }
}
DiagnosticsReport.verify();
