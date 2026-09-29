/*
 * Update-pipeline simulation.
 * Mirrors the flow I built for the lab's robot fleet. It is a teaching
 * demo, not live data: version numbers and timings are examples.
 */
(function () {
    'use strict';

    var stagesEl = document.getElementById('stages');
    if (!stagesEl) { return; }

    var logEl = document.getElementById('log');
    var resultEl = document.getElementById('result');
    var runBtn = document.getElementById('run');
    var confirmBtn = document.getElementById('confirm');
    var faultInputs = document.querySelectorAll('input[name="fault"]');

    var reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var STEP_MS = reduceMotion ? 0 : 650;

    var INSTALLED = '1.4.0';
    var AVAILABLE = '1.5.0';

    // Stage order, log line on success, and the fault (if any) that stops it there.
    var FLOW = [
        { id: 'tag',      ok: 'Tag v' + AVAILABLE + ' pushed. Workflow started.' },
        { id: 'build',    ok: 'Package built. Validation passed.' },
        { id: 'checksum', ok: 'SHA256 computed. Production manifest written.' },
        { id: 'draft',    ok: 'Draft release published with package and manifest.' },
        { id: 'approve',  ok: 'Maintainer approved and published the release.' },

        { id: 'auth',     ok: 'Read-only, single-repository token accepted.',
          fault: 'auth',
          why: 'The token was rejected, so this robot cannot read the release. Each robot has its own token, so the others are unaffected.' },
        { id: 'manifest', ok: 'Manifest parsed. Installed ' + INSTALLED + ', available ' + AVAILABLE + '.',
          fault: 'manifest',
          why: 'The manifest is malformed and was rejected before any download started.' },
        { id: 'download', ok: 'Download complete (.part file).',
          fault: 'network',
          why: 'The connection dropped mid-download. A partial .part file is never treated as a package.' },
        { id: 'verify',   ok: 'SHA256 matches the manifest.',
          fault: 'checksum',
          why: 'The checksum does not match the manifest, so the download was discarded.' },
        { id: 'validate', ok: 'Package structure is valid.' },
        { id: 'promote',  ok: 'Package promoted atomically.' },
        { id: 'confirm',  ok: 'Operator confirmed the install.', gate: true },
        { id: 'install',  ok: 'Installed ' + AVAILABLE + ' and rebooted.' }
    ];

    var FAULT_LOG = {
        auth:     'HTTP 401 from release API.',
        manifest: 'Manifest failed schema check.',
        network:  'Connection reset at 63% of download.',
        checksum: 'SHA256 mismatch. Deleting .part file.'
    };

    var stageEls = {};
    Array.prototype.forEach.call(stagesEl.querySelectorAll('.stage'), function (el) {
        stageEls[el.getAttribute('data-stage')] = el;
    });

    var runToken = 0;
    var gateResolver = null;

    function currentFault() {
        for (var i = 0; i < faultInputs.length; i++) {
            if (faultInputs[i].checked) { return faultInputs[i].value; }
        }
        return 'none';
    }

    function setState(id, state) {
        if (state) { stageEls[id].setAttribute('data-state', state); }
        else { stageEls[id].removeAttribute('data-state'); }
    }

    function addLog(text, cls) {
        var li = document.createElement('li');
        li.textContent = text;
        if (cls) { li.className = cls; }
        logEl.appendChild(li);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setResult(text, tone) {
        resultEl.textContent = text;
        if (tone) { resultEl.setAttribute('data-tone', tone); }
        else { resultEl.removeAttribute('data-tone'); }
    }

    function wait(ms, token) {
        return new Promise(function (resolve) {
            setTimeout(function () { resolve(token === runToken); }, ms);
        });
    }

    function reset() {
        FLOW.forEach(function (s) { setState(s.id, null); });
        logEl.innerHTML = '';
        setResult('', null);
        confirmBtn.hidden = true;
        gateResolver = null;
    }

    async function run() {
        runToken += 1;
        var token = runToken;
        var fault = currentFault();

        reset();
        runBtn.disabled = true;
        setResult('Robot is running ' + INSTALLED + '. Release ' + AVAILABLE + ' is being prepared.', null);

        var failed = false;

        for (var i = 0; i < FLOW.length; i++) {
            var step = FLOW[i];

            if (failed) {
                setState(step.id, 'skipped');
                continue;
            }

            setState(step.id, 'active');
            if (!(await wait(STEP_MS, token))) { return; }

            if (step.fault && step.fault === fault) {
                setState(step.id, 'fail');
                addLog(FAULT_LOG[fault], 'is-fault');
                setResult(step.why + ' Nothing was installed, and the robot is still running ' + INSTALLED + '.', 'fault');
                failed = true;
                continue;
            }

            if (step.gate) {
                setState(step.id, 'waiting');
                addLog('Package staged. Waiting for the operator.', null);
                setResult('Everything checked out. The install still needs a person to confirm it.', null);
                confirmBtn.hidden = false;
                runBtn.disabled = false;
                var stillCurrent = await new Promise(function (resolve) {
                    gateResolver = function () { resolve(token === runToken); };
                });
                if (!stillCurrent) { return; }
                confirmBtn.hidden = true;
                runBtn.disabled = true;
                setResult('', null);
            }

            setState(step.id, 'done');
            addLog(step.ok, null);
        }

        if (token !== runToken) { return; }

        if (!failed) {
            setResult('Robot is now running ' + AVAILABLE + '.', 'ok');
            addLog('Running ' + AVAILABLE + '.', 'is-ok');
        }
        runBtn.disabled = false;
    }

    confirmBtn.addEventListener('click', function () {
        if (gateResolver) { var r = gateResolver; gateResolver = null; r(); }
    });

    runBtn.addEventListener('click', run);

    Array.prototype.forEach.call(faultInputs, function (input) {
        input.addEventListener('change', run);
    });

    // One orchestrated moment on load: the clean run plays up to the operator gate.
    setTimeout(run, reduceMotion ? 0 : 500);
})();
