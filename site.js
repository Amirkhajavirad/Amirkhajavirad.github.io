/*
 * site.js
 * Everything on the page that is not the 3D stage:
 * layer highlighting, the depth-parallax portrait, the draggable project
 * collage with its detail dialog, and the over-the-air update simulation.
 */
(function () {
    'use strict';

    var root = document.documentElement;
    var REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    function $(id) { return document.getElementById(id); }
    function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

    /* ---------- hint text for touch screens ---------- */
    (function () {
        var hint = document.querySelector('[data-hint]');
        if (hint && COARSE) { hint.textContent = 'Scroll to take the stack apart, one layer at a time.'; }
    })();

    /* ---------- mark the layer that is in the middle of the screen ---------- */
    (function () {
        var layers = Array.prototype.slice.call(document.querySelectorAll('.layer'));
        if (!layers.length) { return; }
        var queued = false;
        function update() {
            queued = false;
            var mid = (window.__stage && window.__stage.mid) || window.innerHeight * 0.5;
            layers.forEach(function (el) {
                var r = el.getBoundingClientRect();
                el.classList.toggle('is-active', r.top <= mid && r.bottom > mid);
            });
        }
        function schedule() { if (!queued) { queued = true; requestAnimationFrame(update); } }
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        update();
    })();

    /* ---------- depth portrait: three layers that shift at different rates ---------- */
    (function () {
        var portrait = $('portrait');
        if (!portrait || REDUCE) { return; }
        var tx = 0, ty = 0, cx = 0, cy = 0, running = false;
        function loop() {
            cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
            portrait.style.setProperty('--px', cx.toFixed(3));
            portrait.style.setProperty('--py', cy.toFixed(3));
            if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) { requestAnimationFrame(loop); } else { running = false; }
        }
        window.addEventListener('pointermove', function (e) {
            var r = portrait.getBoundingClientRect();
            if (r.bottom < -200 || r.top > window.innerHeight + 200) { return; }
            tx = clamp((e.clientX - (r.left + r.width / 2)) / (window.innerWidth * 0.45), -1, 1);
            ty = clamp((e.clientY - (r.top + r.height / 2)) / (window.innerHeight * 0.45), -1, 1);
            if (!running) { running = true; requestAnimationFrame(loop); }
        }, { passive: true });
    })();

    /* ---------- portrait video: the portrait from the first paint, looping while on screen ---------- */
    (function () {
        var portrait = $('portrait');
        if (!portrait || REDUCE) { return; }
        var video = portrait.querySelector('.portrait__video');
        if (!video) { return; }
        var conn = navigator.connection;
        if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) { return; }

        // The poster (first frame of the clip) is the portrait until playback starts, so the still layers never show through.
        portrait.classList.add('video-mode');

        // If the clip cannot be used at all, fall back to the still portrait.
        function giveUp() { portrait.classList.remove('video-mode'); }
        video.addEventListener('error', function () { if (video.networkState === 3) { giveUp(); } }, true);
        function play() {
            var p = video.play();
            if (p && p.catch) { p.catch(function (err) { if (err && err.name === 'NotSupportedError') { giveUp(); } }); }
        }

        if ('IntersectionObserver' in window) {
            var io = new IntersectionObserver(function (entries) {
                entries.forEach(function (e) { if (e.isIntersecting) { play(); } else { video.pause(); } });
            }, { threshold: 0.35 });
            io.observe(portrait);
        }
    })();

    /* ---------- project collage and dialog ---------- */
    (function () {
        var collage = $('collage'), dialog = $('proj-dialog'), content = $('dialog-content'), closeBtn = $('dialog-close');
        if (!collage || !dialog) { return; }
        var cards = Array.prototype.slice.call(collage.querySelectorAll('.proj'));
        var opener = null, zTop = 10;
        var wide = window.matchMedia('(min-width: 760px)');

        function openCard(card, from) {
            opener = from || card;
            content.textContent = '';
            var img = card.querySelector('.proj__img'), art = card.querySelector('.proj__art');
            if (img) {
                var im = document.createElement('img'); im.className = 'dialog__img'; im.src = img.currentSrc || img.src; im.alt = img.alt;
                content.appendChild(im);
            } else if (art) {
                var a = art.cloneNode(true); a.classList.add('dialog__art'); content.appendChild(a);
            }
            var h3 = document.createElement('h3'); h3.id = 'dialog-title';
            h3.textContent = card.querySelector('.proj__title').textContent; content.appendChild(h3);
            var meta = card.querySelector('.proj__meta').cloneNode(true); content.appendChild(meta);
            var body = card.querySelector('.proj__body').cloneNode(true); content.appendChild(body);
            if (typeof dialog.showModal === 'function') { dialog.showModal(); } else { dialog.setAttribute('open', ''); }
            closeBtn.focus();
        }
        function closeDialog() {
            if (typeof dialog.close === 'function') { dialog.close(); } else { dialog.removeAttribute('open'); }
        }
        dialog.addEventListener('close', function () { if (opener && opener.focus) { opener.focus({ preventScroll: true }); } });
        dialog.addEventListener('click', function (e) { if (e.target === dialog) { closeDialog(); } });
        closeBtn.addEventListener('click', closeDialog);

        cards.forEach(function (card) {
            var title = card.querySelector('.proj__title').textContent;
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-haspopup', 'dialog');
            card.setAttribute('aria-label', 'Open details: ' + title);

            var dx = 0, dy = 0, sx = 0, sy = 0, bx = 0, by = 0, down = false, moved = false;

            card.addEventListener('pointerdown', function (e) {
                if (!wide.matches || (e.pointerType === 'mouse' && e.button !== 0)) { return; }
                down = true; moved = false; sx = e.clientX; sy = e.clientY; bx = dx; by = dy;
                try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            });
            card.addEventListener('pointermove', function (e) {
                if (!down) { return; }
                var mx = e.clientX - sx, my = e.clientY - sy;
                if (!moved && Math.hypot(mx, my) > 6) { moved = true; card.classList.add('is-dragging'); card.style.zIndex = ++zTop; }
                if (moved) {
                    dx = bx + mx; dy = by + my;
                    card.style.setProperty('--dx', dx + 'px'); card.style.setProperty('--dy', dy + 'px');
                }
            });
            function end() { down = false; card.classList.remove('is-dragging'); }
            card.addEventListener('pointerup', end);
            card.addEventListener('pointercancel', end);
            card.addEventListener('click', function () {
                if (moved) { moved = false; return; }
                openCard(card);
            });
            card.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(card); }
            });
        });

        // "Open the project" buttons elsewhere on the page
        Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (btn) {
            btn.addEventListener('click', function () {
                var card = $('proj-' + btn.getAttribute('data-open'));
                if (card) { openCard(card, btn); }
            });
        });
    })();

    /* ---------- over-the-air update simulation ---------- */
    (function () {
        var stagesEl = $('stages');
        if (!stagesEl) { return; }
        var logEl = $('log'), resultEl = $('result'), runBtn = $('run'), confirmBtn = $('confirm');
        var faultInputs = document.querySelectorAll('input[name="fault"]');
        var STEP_MS = REDUCE ? 0 : 600;
        var INSTALLED = '1.4.0', AVAILABLE = '1.5.0';

        var FLOW = [
            { id: 'tag',      ok: 'Tag v' + AVAILABLE + ' pushed. Workflow started.' },
            { id: 'build',    ok: 'Package built. Validation passed.' },
            { id: 'checksum', ok: 'SHA256 computed. Production manifest written.' },
            { id: 'draft',    ok: 'Draft release published with package and manifest.' },
            { id: 'approve',  ok: 'Maintainer approved and published the release.' },
            { id: 'auth',     ok: 'Read-only, single-repository token accepted.', fault: 'auth',
              why: 'The token was rejected, so this robot cannot read the release. Each robot has its own token, so the others are unaffected.' },
            { id: 'manifest', ok: 'Manifest parsed. Installed ' + INSTALLED + ', available ' + AVAILABLE + '.', fault: 'manifest',
              why: 'The manifest is malformed and was rejected before any download started.' },
            { id: 'download', ok: 'Download complete (.part file).', fault: 'network',
              why: 'The connection dropped mid-download. A partial .part file is never treated as a package.' },
            { id: 'verify',   ok: 'SHA256 matches the manifest.', fault: 'checksum',
              why: 'The checksum does not match the manifest, so the download was discarded.' },
            { id: 'validate', ok: 'Package structure is valid.' },
            { id: 'promote',  ok: 'Package promoted atomically.' },
            { id: 'confirm',  ok: 'Operator confirmed the install.', gate: true },
            { id: 'install',  ok: 'Installed ' + AVAILABLE + ' and rebooted.' }
        ];
        var FAULT_LOG = {
            auth: 'HTTP 401 from release API.', manifest: 'Manifest failed schema check.',
            network: 'Connection reset at 63% of download.', checksum: 'SHA256 mismatch. Deleting .part file.'
        };

        var stageEls = {};
        Array.prototype.forEach.call(stagesEl.querySelectorAll('.stage'), function (el) { stageEls[el.getAttribute('data-stage')] = el; });

        var runToken = 0, gateResolver = null;

        function currentFault() {
            for (var i = 0; i < faultInputs.length; i++) { if (faultInputs[i].checked) { return faultInputs[i].value; } }
            return 'none';
        }
        function setState(id, s) { if (s) { stageEls[id].setAttribute('data-state', s); } else { stageEls[id].removeAttribute('data-state'); } }
        function addLog(text, cls) {
            var li = document.createElement('li'); li.textContent = text; if (cls) { li.className = cls; }
            logEl.appendChild(li); logEl.scrollTop = logEl.scrollHeight;
        }
        function setResult(text, tone) { resultEl.textContent = text; if (tone) { resultEl.setAttribute('data-tone', tone); } else { resultEl.removeAttribute('data-tone'); } }
        function wait(ms, token) { return new Promise(function (res) { setTimeout(function () { res(token === runToken); }, ms); }); }
        function reset() {
            FLOW.forEach(function (s) { setState(s.id, null); });
            logEl.innerHTML = ''; setResult('', null); confirmBtn.hidden = true; gateResolver = null;
        }

        async function run() {
            runToken += 1;
            var token = runToken, fault = currentFault(), failed = false;
            reset(); runBtn.disabled = true;
            setResult('Robot is running ' + INSTALLED + '. Release ' + AVAILABLE + ' is being prepared.', null);

            for (var i = 0; i < FLOW.length; i++) {
                var step = FLOW[i];
                if (failed) { setState(step.id, 'skipped'); continue; }
                setState(step.id, 'active');
                if (!(await wait(STEP_MS, token))) { return; }

                if (step.fault && step.fault === fault) {
                    setState(step.id, 'fail'); addLog(FAULT_LOG[fault], 'is-fault');
                    setResult(step.why + ' Nothing was installed, and the robot is still running ' + INSTALLED + '.', 'fault');
                    failed = true; continue;
                }
                if (step.gate) {
                    setState(step.id, 'waiting'); addLog('Package staged. Waiting for the operator.', null);
                    setResult('Everything checked out. The install still needs a person to confirm it.', null);
                    confirmBtn.hidden = false; runBtn.disabled = false;
                    var current = await new Promise(function (resolve) { gateResolver = function () { resolve(token === runToken); }; });
                    if (!current) { return; }
                    confirmBtn.hidden = true; runBtn.disabled = true; setResult('', null);
                }
                setState(step.id, 'done'); addLog(step.ok, null);
            }
            if (token !== runToken) { return; }
            if (!failed) { setResult('Robot is now running ' + AVAILABLE + '.', 'ok'); addLog('Running ' + AVAILABLE + '.', 'is-ok'); }
            runBtn.disabled = false;
        }

        confirmBtn.addEventListener('click', function () { if (gateResolver) { var r = gateResolver; gateResolver = null; r(); } });
        runBtn.addEventListener('click', run);
        Array.prototype.forEach.call(faultInputs, function (input) { input.addEventListener('change', run); });

        // Start the clean run the first time the panel is on screen.
        var started = false;
        function start() { if (!started) { started = true; run(); } }
        if ('IntersectionObserver' in window) {
            // On a phone the pinned stack covers the top of the screen, so only count what is visible below it.
            var offset = 0;
            if (window.matchMedia('(max-width: 900px) and (min-height: 501px)').matches) {
                var hdr = document.querySelector('.site-header'), scn = document.querySelector('.scene');
                offset = Math.round((hdr ? hdr.getBoundingClientRect().height : 0) + (scn ? scn.getBoundingClientRect().height : 0));
            }
            var io = new IntersectionObserver(function (entries) {
                entries.forEach(function (e) { if (e.isIntersecting) { start(); io.disconnect(); } });
            }, { threshold: 0.25, rootMargin: '-' + offset + 'px 0px 0px 0px' });
            io.observe(stagesEl);
        } else { start(); }
    })();

})();
