/*
 * stage.js
 * A small hand-written WebGL renderer (no libraries) for the fixed 3D stack
 * behind the page. Four layers, bottom to top: Hardware, Software,
 * Network and deployment, Data. The scroll position decides which layer is
 * in focus, the cursor moves the camera and a light, and the layers can be
 * grabbed and turned.
 */
(function () {
    'use strict';

    var canvas = document.getElementById('stage-canvas');
    if (!canvas) { return; }
    var root = document.documentElement;

    var gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true }) ||
             canvas.getContext('experimental-webgl');
    if (!gl) { root.classList.add('no-webgl'); return; }

    var REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- palette ---------- */
    var BG = [0.906, 0.922, 0.945];            // matches --bench
    var ACCENT = [1.0, 0.31, 0.12];            // matches --signal
    var INK = [0.055, 0.082, 0.149];

    var LAYERS = [
        { id: 'hardware', label: 'Hardware' },
        { id: 'software', label: 'Software' },
        { id: 'network',  label: 'Network' },
        { id: 'data',     label: 'Data' }
    ];

    /* slab dimensions (world units) */
    var W = 3.0, D = 2.1, H = 0.16, R = 0.3, BEV = 0.03;
    var TOP = H / 2;

    /* ---------- tiny math ---------- */
    function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
    function damp(cur, target, rate, dt) { return cur + (target - cur) * (1 - Math.exp(-rate * dt)); }
    function easeOut(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }

    var M4 = {
        ident: function () { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); },
        mul: function (a, b) {
            var o = new Float32Array(16);
            for (var c = 0; c < 4; c++) {
                for (var r = 0; r < 4; r++) {
                    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
                }
            }
            return o;
        },
        persp: function (fovy, asp, n, f) {
            var t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
            o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
            return o;
        },
        lookAt: function (e, c, u) {
            var zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
            var zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
            var xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
            var xl = Math.hypot(xx, xy, xz); xx /= xl; xy /= xl; xz /= xl;
            var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
            return new Float32Array([
                xx, yx, zx, 0,  xy, yy, zy, 0,  xz, yz, zz, 0,
                -(xx * e[0] + xy * e[1] + xz * e[2]),
                -(yx * e[0] + yy * e[1] + yz * e[2]),
                -(zx * e[0] + zy * e[1] + zz * e[2]), 1
            ]);
        },
        translate: function (x, y, z) { var m = M4.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
        scale: function (x, y, z) { var m = M4.ident(); m[0] = x; m[5] = y; m[10] = z; return m; },
        rotY: function (a) { var c = Math.cos(a), s = Math.sin(a), m = M4.ident(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
        rotX: function (a) { var c = Math.cos(a), s = Math.sin(a), m = M4.ident(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
        invert: function (m) {
            var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7],
                a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
            var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10,
                b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
                b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30,
                b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
            var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
            if (!det) { return M4.ident(); }
            det = 1 / det;
            var o = new Float32Array(16);
            o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
            o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
            o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
            o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
            o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
            o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
            o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
            o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
            o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
            o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
            o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
            o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
            o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
            o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
            o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
            o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
            return o;
        },
        apply: function (m, x, y, z, w) {
            return [
                m[0] * x + m[4] * y + m[8] * z + m[12] * w,
                m[1] * x + m[5] * y + m[9] * z + m[13] * w,
                m[2] * x + m[6] * y + m[10] * z + m[14] * w,
                m[3] * x + m[7] * y + m[11] * z + m[15] * w
            ];
        }
    };

    /* ---------- geometry ---------- */
    function newMesh() { return { pos: [], nrm: [], uv: [], idx: [] }; }

    function quad(m, a, b, c, d, n) {
        var i = m.pos.length / 3;
        [a, b, c, d].forEach(function (p) { m.pos.push(p[0], p[1], p[2]); m.nrm.push(n[0], n[1], n[2]); });
        m.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
        m.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }

    function boxMesh(w, h, d) {
        var x = w / 2, y = h / 2, z = d / 2, m = newMesh();
        quad(m, [-x,-y, z], [ x,-y, z], [ x, y, z], [-x, y, z], [0, 0, 1]);
        quad(m, [ x,-y,-z], [-x,-y,-z], [-x, y,-z], [ x, y,-z], [0, 0,-1]);
        quad(m, [-x, y, z], [ x, y, z], [ x, y,-z], [-x, y,-z], [0, 1, 0]);
        quad(m, [-x,-y,-z], [ x,-y,-z], [ x,-y, z], [-x,-y, z], [0,-1, 0]);
        quad(m, [ x,-y, z], [ x,-y,-z], [ x, y,-z], [ x, y, z], [1, 0, 0]);
        quad(m, [-x,-y,-z], [-x,-y, z], [-x, y, z], [-x, y,-z], [-1, 0, 0]);
        return m;
    }

    function cylMesh(r, h, seg) {
        var m = newMesh(), y = h / 2, i, a, c, s, base;
        for (i = 0; i <= seg; i++) {
            a = i / seg * Math.PI * 2; c = Math.cos(a); s = Math.sin(a);
            m.pos.push(r * c, -y, r * s, r * c, y, r * s);
            m.nrm.push(c, 0, s, c, 0, s);
            m.uv.push(i / seg, 0, i / seg, 1);
        }
        for (i = 0; i < seg; i++) {
            base = i * 2;
            m.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
        [[y, 1], [-y, -1]].forEach(function (cap) {
            var ci = m.pos.length / 3;
            m.pos.push(0, cap[0], 0); m.nrm.push(0, cap[1], 0); m.uv.push(0.5, 0.5);
            for (i = 0; i <= seg; i++) {
                a = i / seg * Math.PI * 2;
                m.pos.push(r * Math.cos(a), cap[0], r * Math.sin(a)); m.nrm.push(0, cap[1], 0); m.uv.push(0.5, 0.5);
            }
            for (i = 0; i < seg; i++) { m.idx.push(ci, ci + 1 + i, ci + 2 + i); }
        });
        return m;
    }

    function sphereMesh(r, lat, lon) {
        var m = newMesh(), i, j, th, ph, x, y, z;
        for (i = 0; i <= lat; i++) {
            th = i / lat * Math.PI;
            for (j = 0; j <= lon; j++) {
                ph = j / lon * Math.PI * 2;
                x = Math.sin(th) * Math.cos(ph); y = Math.cos(th); z = Math.sin(th) * Math.sin(ph);
                m.pos.push(r * x, r * y, r * z); m.nrm.push(x, y, z); m.uv.push(j / lon, i / lat);
            }
        }
        for (i = 0; i < lat; i++) {
            for (j = 0; j < lon; j++) {
                var a = i * (lon + 1) + j, b = a + lon + 1;
                m.idx.push(a, b, a + 1, b, b + 1, a + 1);
            }
        }
        return m;
    }

    function transformMesh(m, mat) {
        var o = newMesh(), i, p, n;
        for (i = 0; i < m.pos.length; i += 3) {
            p = M4.apply(mat, m.pos[i], m.pos[i + 1], m.pos[i + 2], 1);
            n = M4.apply(mat, m.nrm[i], m.nrm[i + 1], m.nrm[i + 2], 0);
            o.pos.push(p[0], p[1], p[2]); o.nrm.push(n[0], n[1], n[2]);
        }
        o.uv = m.uv.slice(); o.idx = m.idx.slice();
        return o;
    }

    function mergeMeshes(list) {
        var o = newMesh();
        list.forEach(function (m) {
            var off = o.pos.length / 3;
            Array.prototype.push.apply(o.pos, m.pos);
            Array.prototype.push.apply(o.nrm, m.nrm);
            Array.prototype.push.apply(o.uv, m.uv);
            m.idx.forEach(function (k) { o.idx.push(k + off); });
        });
        return o;
    }

    /* Rounded slab with a small bevel. The top face carries UVs. */
    function slabMesh(seg) {
        var pts = [], cx = W / 2 - R, cz = D / 2 - R, corners = [
            [cx, cz, 0], [-cx, cz, Math.PI / 2], [-cx, -cz, Math.PI], [cx, -cz, Math.PI * 1.5]
        ];
        corners.forEach(function (c) {
            for (var s = 0; s <= seg; s++) {
                var a = c[2] + s / seg * Math.PI / 2, nx = Math.cos(a), nz = Math.sin(a);
                pts.push({ x: c[0] + R * nx, z: c[1] + R * nz, nx: nx, nz: nz });
            }
        });
        var m = newMesh();
        function ring(inset, y, sxz, ny, uvMode) {
            var start = m.pos.length / 3;
            pts.forEach(function (p) {
                var x = p.x - p.nx * inset, z = p.z - p.nz * inset;
                var nx = p.nx * sxz, nz = p.nz * sxz, l = Math.hypot(nx, ny, nz);
                m.pos.push(x, y, z); m.nrm.push(nx / l, ny / l, nz / l);
                if (uvMode) { m.uv.push(x / W + 0.5, 1 - (z / D + 0.5)); } else { m.uv.push(0.003, 0.003); }
            });
            return start;
        }
        function bridge(a, b) {
            var n = pts.length;
            for (var i = 0; i < n; i++) {
                var j = (i + 1) % n;
                m.idx.push(a + i, a + j, b + i, a + j, b + j, b + i);
            }
        }
        function fan(ringStart, y, ny) {
            var c = m.pos.length / 3;
            m.pos.push(0, y, 0); m.nrm.push(0, ny, 0); m.uv.push(0.5, 0.5);
            var n = pts.length;
            for (var i = 0; i < n; i++) { m.idx.push(c, ringStart + i, ringStart + (i + 1) % n); }
        }
        var r1 = ring(BEV, TOP, 0, 1, true);
        var r2 = ring(BEV, TOP, 1, 1, true);
        var r3 = ring(0, TOP - BEV, 1, 1, true);
        var r4 = ring(0, TOP - BEV, 1, 0, false);
        var r5 = ring(0, -TOP + BEV, 1, 0, false);
        var r6 = ring(0, -TOP + BEV, 1, -1, false);
        var r7 = ring(BEV, -TOP, 1, -1, false);
        var r8 = ring(BEV, -TOP, 0, -1, false);
        // the centre vertex of the top cap needs its own UV at the centre
        fan(r1, TOP, 1);
        bridge(r2, r3); bridge(r4, r5); bridge(r6, r7);
        fan(r8, -TOP, -1);
        return m;
    }

    var STRIDE = 32;
    function upload(m) {
        var n = m.pos.length / 3, data = new Float32Array(n * 8), i;
        for (i = 0; i < n; i++) {
            data[i * 8] = m.pos[i * 3]; data[i * 8 + 1] = m.pos[i * 3 + 1]; data[i * 8 + 2] = m.pos[i * 3 + 2];
            data[i * 8 + 3] = m.nrm[i * 3]; data[i * 8 + 4] = m.nrm[i * 3 + 1]; data[i * 8 + 5] = m.nrm[i * 3 + 2];
            data[i * 8 + 6] = m.uv[i * 2] || 0; data[i * 8 + 7] = m.uv[i * 2 + 1] || 0;
        }
        var vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        var ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(m.idx), gl.STATIC_DRAW);
        return { vbo: vbo, ibo: ibo, count: m.idx.length };
    }

    /* ---------- shaders ---------- */
    function compile(type, src) {
        var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { throw new Error(gl.getShaderInfoLog(s)); }
        return s;
    }
    function program(vs, fs) {
        var p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { throw new Error(gl.getProgramInfoLog(p)); }
        return p;
    }

    var VS = [
        'attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;',
        'uniform mat4 uMVP; uniform mat4 uModel;',
        'varying vec3 vN; varying vec3 vW; varying vec2 vUv;',
        'void main(){ vec4 w = uModel * vec4(aPos,1.0); vW = w.xyz; vN = mat3(uModel) * aNrm; vUv = aUv;',
        '  gl_Position = uMVP * vec4(aPos,1.0); }'
    ].join('\n');

    var FS = [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
        'varying vec3 vN; varying vec3 vW; varying vec2 vUv;',
        'uniform sampler2D uTexA; uniform sampler2D uTexB; uniform float uMixT; uniform float uHasTex;',
        'uniform vec3 uColor; uniform vec3 uBg; uniform float uFade;',
        'uniform vec3 uGlowCol; uniform float uGlow;',
        'uniform vec3 uCam; uniform vec3 uLight; uniform float uSpec; uniform float uShiny;',
        'uniform vec3 uRimCol; uniform float uRim;',
        'void main(){',
        '  vec3 N = normalize(vN);',
        '  vec3 base = uColor;',
        '  if (uHasTex > 0.5) { base = mix(texture2D(uTexA, vUv).rgb, texture2D(uTexB, vUv).rgb, uMixT) * uColor; }',
        '  vec3 V = normalize(uCam - vW);',
        '  vec3 Lk = normalize(vec3(-0.45, 1.0, 0.7));',
        '  float dk = max(dot(N, Lk), 0.0);',
        '  float hemi = 0.5 + 0.5 * N.y;',
        '  vec3 Lc = uLight - vW; float dist = length(Lc); Lc /= dist;',
        '  float att = 1.0 / (1.0 + 0.09 * dist * dist);',
        '  float dc = max(dot(N, Lc), 0.0) * att;',
        '  vec3 Hh = normalize(Lc + V);',
        '  float sp = pow(max(dot(N, Hh), 0.0), uShiny) * uSpec * (0.25 + 1.0 * att);',
        '  vec3 Hk = normalize(Lk + V);',
        '  sp += pow(max(dot(N, Hk), 0.0), uShiny * 0.8) * uSpec * 0.22;',
        '  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);',
        '  vec3 lit = base * (0.44 + 0.16 * hemi + 0.30 * dk + 0.32 * dc) + vec3(sp);',
        '  lit += uRimCol * fres * uRim;',
        '  lit = mix(lit, uGlowCol, uGlow);',
        '  lit = mix(lit, uBg, uFade);',
        '  gl_FragColor = vec4(lit, 1.0);',
        '}'
    ].join('\n');

    var SVS = [
        'attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;',
        'uniform mat4 uMVP; varying vec2 vUv;',
        'void main(){ vUv = aUv; gl_Position = uMVP * vec4(aPos,1.0); }'
    ].join('\n');
    var SFS = [
        'precision mediump float; varying vec2 vUv; uniform float uAlpha;',
        'void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a = a * a * uAlpha;',
        '  gl_FragColor = vec4(vec3(0.05, 0.07, 0.14) * a, a); }'
    ].join('\n');

    var prog, sprog, U = {}, SU = {};
    try {
        prog = program(VS, FS); sprog = program(SVS, SFS);
    } catch (err) {
        if (window.console) { console.warn('3D stage disabled:', err.message); }
        root.classList.add('no-webgl');
        return;
    }
    ['uMVP', 'uModel', 'uTexA', 'uTexB', 'uMixT', 'uHasTex', 'uColor', 'uBg', 'uFade', 'uGlowCol', 'uGlow',
     'uCam', 'uLight', 'uSpec', 'uShiny', 'uRimCol', 'uRim'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    ['uMVP', 'uAlpha'].forEach(function (n) { SU[n] = gl.getUniformLocation(sprog, n); });
    var A = {
        pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'), uv: gl.getAttribLocation(prog, 'aUv'),
        spos: gl.getAttribLocation(sprog, 'aPos'), snrm: gl.getAttribLocation(sprog, 'aNrm'), suv: gl.getAttribLocation(sprog, 'aUv')
    };

    function bindMesh(mesh, a) {
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
        gl.enableVertexAttribArray(a.p); gl.vertexAttribPointer(a.p, 3, gl.FLOAT, false, STRIDE, 0);
        if (a.n >= 0) { gl.enableVertexAttribArray(a.n); gl.vertexAttribPointer(a.n, 3, gl.FLOAT, false, STRIDE, 12); }
        if (a.u >= 0) { gl.enableVertexAttribArray(a.u); gl.vertexAttribPointer(a.u, 2, gl.FLOAT, false, STRIDE, 24); }
    }

    /* ---------- procedural textures (drawn in world units, 3.0 x 2.1) ---------- */
    function rng(seed) {
        return function () {
            seed |= 0; seed = seed + 0x6D2B79F5 | 0;
            var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    function rgb(c) { return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')'; }

    var PAL_CALM   = { line: '#8D9AB6', faint: '#E3E8F0', dot: '#AEB9CF', accent: '#8D9AB6', ink: '#8D9AB6', fill: '#EEF1F7' };
    var PAL_ACTIVE = { line: '#0E1526', faint: '#E6EAF1', dot: '#3B4766', accent: '#FF4F1F', ink: '#0E1526', fill: '#FFE7DF' };

    function makeCanvas() {
        var c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
        var ctx = c.getContext('2d');
        ctx.setTransform(1024 / W, 0, 0, 1024 / D, 1024 / 2, 1024 / 2);
        return { c: c, ctx: ctx };
    }

    function base(ctx, p) {
        ctx.fillStyle = '#FBFCFD'; ctx.fillRect(-W / 2, -D / 2, W, D);
        ctx.strokeStyle = p.faint; ctx.lineWidth = 0.004;
        var x, z;
        for (x = -1.5; x <= 1.5; x += 0.15) { ctx.beginPath(); ctx.moveTo(x, -D / 2); ctx.lineTo(x, D / 2); ctx.stroke(); }
        for (z = -1.05; z <= 1.05; z += 0.15) { ctx.beginPath(); ctx.moveTo(-W / 2, z); ctx.lineTo(W / 2, z); ctx.stroke(); }
        ctx.strokeStyle = p.line; ctx.lineWidth = 0.008;
        rrect(ctx, -W / 2 + 0.14, -D / 2 + 0.14, W - 0.28, D - 0.28, 0.16); ctx.stroke();
    }
    function rrect(ctx, x, y, w, h, r) {
        ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
    }
    function pad(ctx, x, z, r, p) {
        ctx.fillStyle = p.line; ctx.beginPath(); ctx.arc(x, z, r, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#FBFCFD'; ctx.beginPath(); ctx.arc(x, z, r * 0.45, 0, 6.2832); ctx.fill();
    }
    function poly(ctx, pts, color, lw) {
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath(); pts.forEach(function (q, i) { if (i) { ctx.lineTo(q[0], q[1]); } else { ctx.moveTo(q[0], q[1]); } }); ctx.stroke();
    }

    var TEX_DRAW = {
        hardware: function (ctx, p) {
            base(ctx, p);
            var traces = [
                [[-1.25,-0.9],[-1.25,-0.62],[-1.0,-0.62],[-0.86,-0.48],[-0.86,-0.2]],
                [[-1.15,0.9],[-1.15,0.5],[-0.95,0.3],[-0.86,0.3]],
                [[-0.24,-0.2],[-0.05,-0.2],[0.15,0.0],[0.5,0.0],[0.6,0.1]],
                [[-0.24,-0.05],[0.0,-0.05],[0.2,0.15],[0.2,0.5],[0.45,0.75]],
                [[-0.24,0.1],[-0.1,0.1],[0.1,0.3],[0.1,0.9]],
                [[0.6,-0.5],[0.25,-0.5],[0.05,-0.7],[-0.5,-0.7]],
                [[1.25,0.9],[1.25,0.45],[1.1,0.3]],
                [[-1.25,0.0],[-1.1,0.0],[-1.0,0.1],[-1.0,0.28]]
            ];
            traces.forEach(function (t) { poly(ctx, t, p.line, 0.018); pad(ctx, t[0][0], t[0][1], 0.04, p); pad(ctx, t[t.length - 1][0], t[t.length - 1][1], 0.04, p); });
            poly(ctx, [[0.6,-0.7],[0.9,-0.7],[1.0,-0.72],[1.15,-0.72]], p.accent, 0.022);
            ctx.strokeStyle = p.line; ctx.lineWidth = 0.008;
            ctx.strokeRect(-0.86, -0.51, 0.62, 0.62);
            ctx.beginPath(); ctx.arc(0.78, 0.3, 0.32, 0, 6.2832); ctx.stroke();
            ctx.strokeRect(-1.0, 0.595, 1.0, 0.17);
            var r = rng(7), i;
            for (i = 0; i < 18; i++) { pad(ctx, -1.2 + r() * 2.4, -0.95 + r() * 1.9, 0.014, p); }
        },
        software: function (ctx, p) {
            base(ctx, p);
            var r = rng(11), i, y, len;
            ctx.fillStyle = p.dot;
            for (i = 0; i < 9; i++) {
                y = 0.62 + i * 0.045; if (y > 0.93) { break; }
                len = 0.35 + r() * 1.1;
                rrect(ctx, -1.25 + (i % 3) * 0.09, y, len, 0.02, 0.01); ctx.fill();
            }
            var nx = [-1.0, -0.4, 0.2, 0.8], k;
            for (k = 0; k < nx.length; k++) {
                if (k < nx.length - 1) { poly(ctx, [[nx[k] + 0.09, -0.78], [nx[k + 1] - 0.09, -0.78]], p.line, 0.012); }
                ctx.fillStyle = (k === 2) ? p.accent : '#FBFCFD';
                ctx.strokeStyle = p.line; ctx.lineWidth = 0.012;
                ctx.beginPath(); ctx.arc(nx[k], -0.78, 0.075, 0, 6.2832); ctx.fill(); ctx.stroke();
            }
            for (i = 0; i < 3; i++) { ctx.strokeStyle = p.line; ctx.lineWidth = 0.008; ctx.beginPath(); ctx.arc(1.18, -0.45 + i * 0.45, 0.19, 0, 6.2832); ctx.stroke(); }
            poly(ctx, [[0.98,-0.05],[0.85,-0.05]], p.line, 0.008);
        },
        network: function (ctx, p) {
            base(ctx, p);
            var rel = [0, -0.62], robots = [[-0.95, 0.55], [0, 0.68], [0.95, 0.55]];
            ctx.setLineDash([0.06, 0.05]);
            robots.forEach(function (q, i) { poly(ctx, [rel, q], i === 1 ? p.accent : p.line, 0.02); });
            ctx.setLineDash([]);
            [rel].concat(robots).forEach(function (q) {
                [0.42, 0.3].forEach(function (rr, i) { ctx.strokeStyle = p.line; ctx.lineWidth = 0.006 + i * 0.004; ctx.beginPath(); ctx.arc(q[0], q[1], rr, 0, 6.2832); ctx.stroke(); });
            });
            var r = rng(3), i;
            for (i = 0; i < 26; i++) { pad(ctx, -1.25 + r() * 2.5, -0.95 + r() * 1.9, 0.012, p); }
        },
        data: function (ctx, p) {
            base(ctx, p);
            ctx.strokeStyle = p.line; ctx.lineWidth = 0.012;
            poly(ctx, [[-1.25, -0.9], [-1.25, 0.05], [1.25, 0.05]], p.line, 0.012);
            // confidence band and fit
            ctx.fillStyle = p.fill;
            ctx.beginPath(); ctx.moveTo(-1.2, -0.05); ctx.lineTo(1.2, -0.7); ctx.lineTo(1.2, -0.3); ctx.lineTo(-1.2, 0.0); ctx.closePath(); ctx.fill();
            poly(ctx, [[-1.2, -0.03], [1.2, -0.5]], p.accent, 0.018);
            var r = rng(5), i, x, z;
            for (i = 0; i < 22; i++) {
                x = -1.15 + i * 0.105; z = -0.03 - (x + 1.2) * 0.195 + (r() - 0.5) * 0.34;
                ctx.fillStyle = p.dot; ctx.beginPath(); ctx.arc(x, z, 0.03, 0, 6.2832); ctx.fill();
            }
            for (i = 0; i < 7; i++) { poly(ctx, [[-1.3, 0.25 + i * 0], [-1.3, 0.25]], p.line, 0.001); }
            poly(ctx, [[-1.25, 0.95], [1.25, 0.95]], p.line, 0.008);
        }
    };

    function drawUI() {
        var t = makeCanvas(), ctx = t.ctx;
        ctx.fillStyle = '#141B2C'; ctx.fillRect(-W / 2, -D / 2, W, D);
        var sx = -0.7, sw = 1.4, i;
        ctx.fillStyle = '#232E4A'; rrect(ctx, sx, -0.42, sw, 0.14, 0.03); ctx.fill();
        for (i = 0; i < 4; i++) {
            ctx.fillStyle = i < 3 ? '#8DA0C8' : '#3A4868'; ctx.beginPath(); ctx.arc(sx + 0.1, -0.16 + i * 0.13, 0.03, 0, 6.2832); ctx.fill();
            ctx.fillStyle = i < 3 ? '#5C6D93' : '#2E3A57'; rrect(ctx, sx + 0.18, -0.18 + i * 0.13, 0.45 + i * 0.12, 0.04, 0.02); ctx.fill();
        }
        ctx.fillStyle = '#FF4F1F'; rrect(ctx, sx + 0.9, 0.16, 0.42, 0.2, 0.05); ctx.fill();
        return t.c;
    }

    function texFromCanvas(c) {
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        var ext = gl.getExtension('EXT_texture_filter_anisotropic');
        if (ext) { gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT))); }
        return t;
    }
    function slabTexture(name, pal) { var t = makeCanvas(); TEX_DRAW[name](t.ctx, pal); return texFromCanvas(t.c); }

    var whiteTex = (function () {
        var c = document.createElement('canvas'); c.width = c.height = 2;
        var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 2, 2);
        return texFromCanvas(c);
    })();

    /* ---------- scene ---------- */
    var slabGeo = upload(slabMesh(8));
    var GEO = {
        slab: slabGeo,
        chip: upload(boxMesh(0.62, 0.07, 0.62)),
        chipTop: upload(boxMesh(0.5, 0.012, 0.5)),
        pinBase: upload(boxMesh(1.15, 0.06, 0.2)),
        motor: upload(cylMesh(0.26, 0.34, 28)),
        motorCap: upload(cylMesh(0.2, 0.03, 24)),
        shaft: upload(cylMesh(0.05, 0.22, 14)),
        loadCell: upload(boxMesh(1.0, 0.10, 0.17)),
        led: upload(sphereMesh(0.05, 10, 14)),
        bezel: upload(boxMesh(1.5, 0.05, 0.96)),
        screen: upload(boxMesh(1.4, 0.01, 0.86)),
        btn: upload(cylMesh(0.13, 0.05, 24)),
        relNode: upload(cylMesh(0.2, 0.2, 28)),
        relCap: upload(cylMesh(0.12, 0.02, 24)),
        robot: upload(boxMesh(0.34, 0.16, 0.34)),
        robotTop: upload(boxMesh(0.2, 0.02, 0.2)),
        packet: upload(sphereMesh(0.05, 10, 14)),
        bar: upload(boxMesh(0.2, 1, 0.2))
    };
    (function () {
        var pins = [], i, row;
        for (row = 0; row < 2; row++) {
            for (i = 0; i < 13; i++) {
                pins.push(transformMesh(boxMesh(0.04, 0.1, 0.04), M4.translate(-0.5 + i * 0.085, 0.05, -0.04 + row * 0.085)));
            }
        }
        GEO.pins = upload(mergeMeshes(pins));
        var r = rng(21), dots = [], k;
        for (k = 0; k < 14; k++) {
            dots.push(transformMesh(sphereMesh(0.038, 8, 10), M4.translate(-1.15 + r() * 2.3, 0, -0.85 + r() * 0.75)));
        }
        GEO.scatter = upload(mergeMeshes(dots));
    })();

    var UITEX = texFromCanvas(drawUI());
    var slabs = LAYERS.map(function (L, i) {
        return { i: i, id: L.id, label: L.label, texA: slabTexture(L.id, PAL_CALM), texB: slabTexture(L.id, PAL_ACTIVE),
                 mix: 0, fade: 0, lift: 0, hover: 0, y: 0, model: M4.ident(), intro: REDUCE ? 1 : 0 };
    });

    var C = {
        porcelain: [0.98, 0.985, 0.99], chip: [0.10, 0.13, 0.21], chip2: [0.15, 0.19, 0.29], steel: [0.78, 0.82, 0.87],
        steelDark: [0.48, 0.53, 0.63], alu: [0.68, 0.72, 0.79], ink: [0.12, 0.16, 0.27], slate: [0.5, 0.55, 0.67],
        signal: ACCENT, white: [1, 1, 1]
    };

    var NET_REL = [0, -0.62], NET_ROBOTS = [[-0.95, 0.55], [0, 0.68], [0.95, 0.55]];
    var BAR_H = [0.18, 0.32, 0.26, 0.5, 0.4, 0.62, 0.48];

    /* ---------- state ---------- */
    var state = {
        w: 1, h: 1, dpr: 1, aspect: 1,
        px: 0, py: 0, ptx: 0, pty: 0,            // pointer, smoothed and target (-1..1)
        clientX: -1, clientY: -1, pointerSeen: false,
        yaw: 0, yawVel: 0, dragging: false, dragX: 0,
        explode: REDUCE ? 0.25 : 0, explodeT: 0.25,
        active: -1, activeT: -1, presence: 1, camY: 0,
        hover: -1, ready: false, t0: performance.now(),
        shiftX: 0, shiftY: 0, dist: 11.5,
        lightW: [0, 3, 6]
    };
    window.__stage = state;

    /* ---------- DOM labels that follow the slabs ---------- */
    var host = canvas.parentNode;
    var labelHost = document.getElementById('stage-labels');
    var labels = slabs.map(function (s) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'stage-label'; b.textContent = s.label;
        b.setAttribute('aria-label', 'Go to the ' + s.label + ' section');
        b.addEventListener('click', function () { goTo(s.id); });
        if (labelHost) { labelHost.appendChild(b); }
        return b;
    });
    function goTo(id) {
        var el = document.getElementById(id);
        if (el) { el.scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'start' }); }
    }

    /* ---------- sizing ---------- */
    function resize() {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
        state.w = w; state.h = h; state.dpr = dpr; state.aspect = w / h;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        var a = state.aspect;
        state.strip = !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
        if (state.strip) { state.shiftX = 0; state.shiftY = 0.05; }
        else if (a >= 1.15) { state.shiftX = clamp(0.26 + (a - 1.15) * 0.36, 0.26, 0.41); state.shiftY = -0.02; }
        else if (a >= 0.85) { state.shiftX = 0.16; state.shiftY = 0.22; }
        else { state.shiftX = 0; state.shiftY = 0.30; }
        var fov = 0.5;
        if (state.strip) { state.dist = Math.max(10.2, 5.4 / (2 * Math.tan(fov / 2) * a)); }
        else {
            state.dist = Math.max(12, 5.2 / (2 * Math.tan(fov / 2) * a));
            if (a >= 0.85 && a < 1.15) { state.dist = Math.max(state.dist, 13.5); }
        }
        scrollDirty = true;
    }

    /* ---------- scroll -> targets ---------- */
    var scrollDirty = true, layerEls = [], heroEl = null;
    function collect() {
        heroEl = document.getElementById('top');
        layerEls = LAYERS.map(function (L) { return document.getElementById(L.id); });
    }
    function updateTargets() {
        scrollDirty = false;
        var vh = window.innerHeight, sy = window.scrollY || window.pageYOffset;
        var hdr = document.querySelector('.site-header');
        var hb = hdr ? hdr.getBoundingClientRect().bottom : 0;
        var mid = state.strip ? hb + state.h + 70 : vh * 0.5, active = -1, i, r;
        state.mid = mid;
        for (i = 0; i < layerEls.length; i++) {
            if (!layerEls[i]) { continue; }
            r = layerEls[i].getBoundingClientRect();
            if (r.top <= mid && r.bottom > mid) { active = i; }
        }
        // between two layers keep the last one that was above the line
        if (active < 0) {
            for (i = layerEls.length - 1; i >= 0; i--) {
                if (layerEls[i] && layerEls[i].getBoundingClientRect().bottom <= mid) { break; }
            }
        }
        state.activeT = active;
        var first = layerEls[0] ? layerEls[0].getBoundingClientRect() : null;
        var hp = clamp(sy / (vh * 0.75), 0, 1);
        var exploded = first && first.top < vh * 0.9;
        state.explodeT = exploded ? 1 : lerp(0.25, 0.85, hp);
        var last = layerEls[layerEls.length - 1];
        var lastR = last ? last.getBoundingClientRect() : null;
        if (!lastR) { state.presence = 1; }
        else if (state.strip) { state.presence = clamp((lastR.bottom - (hb + state.h + 20)) / 160, 0, 1); }
        else { state.presence = clamp((lastR.bottom - mid * 0.6) / (vh * 0.35), 0, 1); }
    }
    window.addEventListener('scroll', function () { scrollDirty = true; }, { passive: true });

    /* ---------- pointer tracking ---------- */
    function setPointer(x, y) {
        state.clientX = x; state.clientY = y; state.pointerSeen = true;
        state.ptx = clamp((x / window.innerWidth) * 2 - 1, -1, 1);
        state.pty = clamp((y / window.innerHeight) * 2 - 1, -1, 1);
    }
    window.addEventListener('pointermove', function (e) {
        setPointer(e.clientX, e.clientY);
        if (state.dragging && e.pointerType !== 'touch') {
            var dx = e.clientX - state.dragX; state.dragX = e.clientX; state.dragDist += Math.abs(dx);
            state.yaw += dx * 0.009; state.yawVel = dx * 0.009;
        }
    }, { passive: true });
    window.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch' || e.button !== 0) { return; }
        if (state.hover >= 0 && isBackdrop(e.target)) { state.dragging = true; state.dragX = e.clientX; state.yawVel = 0; state.dragDist = 0; root.classList.add('is-grabbing'); }
    });
    window.addEventListener('pointerup', function (e) {
        if (state.dragging) { state.dragging = false; root.classList.remove('is-grabbing'); }
    });
    window.addEventListener('click', function (e) {
        if (state.hover >= 0 && isBackdrop(e.target) && !(state.dragDist > 5)) { goTo(LAYERS[state.hover].id); }
        state.dragDist = 0;
    });
    document.addEventListener('mouseleave', function () { state.pointerSeen = false; state.ptx = 0; state.pty = 0; state.hover = -1; });
    function isBackdrop(t) {
        return !t.closest('a, button, summary, input, label, dialog, .layer__text, .site-header, .site-footer, .pipeline, .collage, .path, .about, .contact-block, .toolbox');
    }

    /* ---------- picking ---------- */
    function rayFromPointer(invVP) {
        var nx = (state.lx / state.w) * 2 - 1, ny = -((state.ly / state.h) * 2 - 1);
        var a = M4.apply(invVP, nx, ny, -1, 1), b = M4.apply(invVP, nx, ny, 1, 1);
        var o = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], f = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
        var d = [f[0] - o[0], f[1] - o[1], f[2] - o[2]], l = Math.hypot(d[0], d[1], d[2]);
        return { o: o, d: [d[0] / l, d[1] / l, d[2] / l] };
    }
    function hitSlab(ray, model) {
        var inv = M4.invert(model);
        var o = M4.apply(inv, ray.o[0], ray.o[1], ray.o[2], 1), d = M4.apply(inv, ray.d[0], ray.d[1], ray.d[2], 0);
        var lo = [-W / 2, -H / 2, -D / 2], hi = [W / 2, 0.6, D / 2], tmin = 0, tmax = 1e9, k, t1, t2, tmp;
        for (k = 0; k < 3; k++) {
            if (Math.abs(d[k]) < 1e-8) { if (o[k] < lo[k] || o[k] > hi[k]) { return -1; } continue; }
            t1 = (lo[k] - o[k]) / d[k]; t2 = (hi[k] - o[k]) / d[k];
            if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
            if (tmin > tmax) { return -1; }
        }
        return tmin;
    }

    /* ---------- drawing ---------- */
    var VP = M4.ident(), camPos = [0, 2, 11];
    function setCommon() {
        gl.uniform3fv(U.uCam, camPos);
        gl.uniform3fv(U.uLight, state.lightW);
        gl.uniform3fv(U.uBg, BG);
        gl.uniform1i(U.uTexA, 0); gl.uniform1i(U.uTexB, 1);
    }
    function drawPart(geo, model, o) {
        o = o || {};
        gl.uniformMatrix4fv(U.uMVP, false, M4.mul(VP, model));
        gl.uniformMatrix4fv(U.uModel, false, model);
        gl.uniform3fv(U.uColor, o.color || C.white);
        gl.uniform1f(U.uFade, o.fade || 0);
        gl.uniform1f(U.uGlow, o.glow || 0);
        gl.uniform3fv(U.uGlowCol, o.glowCol || ACCENT);
        gl.uniform1f(U.uSpec, o.spec === undefined ? 0.25 : o.spec);
        gl.uniform1f(U.uShiny, o.shiny || 40);
        gl.uniform1f(U.uRim, o.rim || 0);
        gl.uniform3fv(U.uRimCol, o.rimCol || ACCENT);
        if (o.texA) {
            gl.uniform1f(U.uHasTex, 1); gl.uniform1f(U.uMixT, o.mix || 0);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, o.texA);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, o.texB || o.texA);
        } else {
            gl.uniform1f(U.uHasTex, 0);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, whiteTex);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, whiteTex);
        }
        bindMesh(geo, { p: A.pos, n: A.nrm, u: A.uv });
        gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
    }

    function place(slabModel, x, y, z, sx, sy, sz) {
        var m = M4.mul(slabModel, M4.translate(x, y, z));
        return sx ? M4.mul(m, M4.scale(sx, sy, sz)) : m;
    }

    function drawSlabParts(s, t, fade, rimA) {
        var m = s.model, o = { fade: fade }, k, tt;
        function P(g, x, y, z, color, extra) {
            var opts = { fade: fade, color: color };
            if (extra) { for (var key in extra) { opts[key] = extra[key]; } }
            drawPart(GEO[g], place(m, x, y, z), opts);
        }
        if (s.id === 'hardware') {
            P('chip', -0.55, TOP + 0.035, -0.2, C.chip, { spec: 0.6, shiny: 60 });
            P('chipTop', -0.55, TOP + 0.076, -0.2, C.chip2, { spec: 0.3 });
            P('pinBase', 0.02, TOP + 0.03, -0.84, C.chip, {});
            P('pins', 0.02, TOP + 0.06, -0.82, C.steel, { spec: 0.8, shiny: 80 });
            P('motor', 0.78, TOP + 0.17, 0.3, C.steel, { spec: 0.7, shiny: 70 });
            P('motorCap', 0.78, TOP + 0.355, 0.3, C.steelDark, { spec: 0.6 });
            P('shaft', 0.78, TOP + 0.47, 0.3, C.slate, { spec: 0.9, shiny: 90 });
            P('loadCell', -0.5, TOP + 0.05, 0.68, C.alu, { spec: 0.7, shiny: 60 });
            var pulse = 0.55 + 0.45 * Math.sin(t * 3.2);
            P('led', 1.15, TOP + 0.05, -0.72, C.signal, { glow: REDUCE ? 0.7 : 0.35 + 0.5 * pulse });
        } else if (s.id === 'software') {
            P('bezel', 0, TOP + 0.025, 0.02, C.chip, { spec: 0.5, shiny: 60 });
            drawPart(GEO.screen, place(m, 0, TOP + 0.055, 0.02), { fade: fade, texA: UITEX, spec: 0.5, shiny: 90 });
            P('btn', 1.18, TOP + 0.025, -0.45, C.ink, { spec: 0.5 });
            P('btn', 1.18, TOP + 0.025, 0.0, C.ink, { spec: 0.5 });
            P('btn', 1.18, TOP + 0.025, 0.45, C.signal, { glow: 0.12 + 0.18 * s.mix, spec: 0.5 });
        } else if (s.id === 'network') {
            P('relNode', NET_REL[0], TOP + 0.1, NET_REL[1], C.steel, { spec: 0.6 });
            P('relCap', NET_REL[0], TOP + 0.21, NET_REL[1], C.signal, { glow: 0.15 });
            for (k = 0; k < 3; k++) {
                P('robot', NET_ROBOTS[k][0], TOP + 0.08, NET_ROBOTS[k][1], C.steel, { spec: 0.5 });
                P('robotTop', NET_ROBOTS[k][0], TOP + 0.17, NET_ROBOTS[k][1], C.chip, { spec: 0.4 });
            }
            for (k = 0; k < 3; k++) {
                tt = REDUCE ? 0.5 : ((t * (0.28 + 0.22 * s.mix) + k * 0.31) % 1);
                var e = tt * tt * (3 - 2 * tt);
                var px = lerp(NET_REL[0], NET_ROBOTS[k][0], e), pz = lerp(NET_REL[1], NET_ROBOTS[k][1], e);
                var hop = Math.sin(e * Math.PI) * 0.12;
                P('packet', px, TOP + 0.09 + hop, pz, C.signal, { glow: 0.55 });
            }
        } else if (s.id === 'data') {
            for (k = 0; k < BAR_H.length; k++) {
                var hgt = BAR_H[k] * (1 + (REDUCE ? 0 : 0.06 * Math.sin(t * 1.4 + k))) * (0.85 + 0.15 * s.mix);
                drawPart(GEO.bar, M4.mul(m, M4.mul(M4.translate(-1.0 + k * 0.335, TOP + hgt / 2, 0.52), M4.scale(1, hgt, 1))),
                    { fade: fade, color: k === 5 ? C.signal : C.ink, spec: 0.5, shiny: 50, glow: k === 5 ? 0.05 : 0 });
            }
            P('scatter', 0, TOP + 0.038, 0, C.slate, { spec: 0.4 });
        }
    }

    function frame(now) {
        rafId = requestAnimationFrame(frame);
        var dt = Math.min(0.05, (now - last) / 1000); last = now;
        var t = (now - state.t0) / 1000;
        if (scrollDirty) { updateTargets(); }

        // smoothing
        var k = REDUCE ? 1000 : 1;
        state.lx = state.lx || 0; state.ly = state.ly || 0;
        state.px = damp(state.px, state.pointerSeen ? state.ptx : 0, 5 * k, dt);
        state.py = damp(state.py, state.pointerSeen ? state.pty : 0, 5 * k, dt);
        state.explode = damp(state.explode, state.explodeT, 3.2 * k, dt);
        state.camY = damp(state.camY, state.activeT >= 0 ? (state.activeT - 1.5) * lerp(0.36, 1.0, state.explode) * 0.3 : 0, 3 * k, dt);
        if (!state.dragging) { state.yaw += state.yawVel; state.yawVel *= 0.93; state.yaw = damp(state.yaw, 0, 0.35, dt); }
        state.active = state.activeT;

        var presence = state.presence;
        if (state.strip) {
            // the strip has an opaque backdrop, so slide it away instead of fading it
            host.style.opacity = '1';
            host.style.transform = presence < 1 ? 'translateY(' + Math.round(-(1 - presence) * (state.h + 100)) + 'px)' : '';
        } else {
            host.style.opacity = presence.toFixed(3); host.style.transform = '';
        }
        host.style.visibility = presence < 0.01 ? 'hidden' : 'visible';
        if (presence < 0.01) { labels.forEach(function (l) { l.style.visibility = 'hidden'; }); return; }
        var cr = canvas.getBoundingClientRect();
        state.lx = state.clientX - cr.left; state.ly = state.clientY - cr.top;
        var inside = state.pointerSeen && state.lx >= 0 && state.lx <= state.w && state.ly >= 0 && state.ly <= state.h;

        // camera
        var az = -0.62 + state.px * (REDUCE ? 0 : 0.28) + state.yaw + (REDUCE ? 0 : Math.sin(t * 0.35) * 0.04);
        var el = 0.44 - state.py * (REDUCE ? 0 : 0.10);
        var d = state.dist;
        camPos = [Math.sin(az) * Math.cos(el) * d, state.camY + Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d];
        var view = M4.lookAt(camPos, [0, state.camY, 0], [0, 1, 0]);
        var proj = M4.persp(0.5, state.aspect, 1, 60);
        var shift = M4.ident(); shift[12] = state.shiftX; shift[13] = state.shiftY;
        VP = M4.mul(shift, M4.mul(proj, view));

        // cursor light
        var invVP = M4.invert(VP);
        var px = inside ? state.lx : state.w * 0.68, py = inside ? state.ly : state.h * 0.3;
        var nx = (px / state.w) * 2 - 1, ny = -((py / state.h) * 2 - 1);
        var a0 = M4.apply(invVP, nx, ny, -1, 1), a1 = M4.apply(invVP, nx, ny, 1, 1);
        var o = [a0[0] / a0[3], a0[1] / a0[3], a0[2] / a0[3]], f = [a1[0] / a1[3], a1[1] / a1[3], a1[2] / a1[3]];
        var dir = [f[0] - o[0], f[1] - o[1], f[2] - o[2]], dl = Math.hypot(dir[0], dir[1], dir[2]);
        dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
        state.lightW = [o[0] + dir[0] * d * 0.82, o[1] + dir[1] * d * 0.82 + 0.6, o[2] + dir[2] * d * 0.82];

        // slab placement
        var gap = lerp(0.36, 1.0, state.explode), best = -1, bestT = 1e9;
        slabs.forEach(function (s, i) {
            var ie = REDUCE ? 1 : easeOut((now - state.t0 - 250 - i * 140) / 1000);
            s.intro = ie;
            s.mix = damp(s.mix, state.active === i ? 1 : 0, 6 * k, dt);
            s.hover = damp(s.hover, state.hover === i ? 1 : 0, 10 * k, dt);
            var others = state.active >= 0 && state.active !== i ? 1 : 0;
            s.fade = damp(s.fade, others * 0.5, 5 * k, dt);
            s.lift = damp(s.lift, (state.active === i ? 0.32 : 0) + s.hover * 0.1, 6 * k, dt);
            var y = (i - 1.5) * gap + (1 - ie) * 2.6;
            var model = M4.mul(M4.translate(0, y + s.lift * 0.35, s.lift * 0.9), M4.rotY((1 - ie) * -0.7));
            s.model = model; s.y = y;
        });
        // hover picking (desktop only, after the intro)
        if (inside && state.explode > 0.6 && presence > 0.5 && !state.dragging) {
            var ray = { o: o, d: dir };
            slabs.forEach(function (s, i) {
                var th = hitSlab(ray, s.model);
                if (th >= 0 && th < bestT) { bestT = th; best = i; }
            });
            state.hover = best;
        } else if (!state.dragging) { state.hover = -1; }
        root.classList.toggle('is-over-stack', state.hover >= 0);

        // render
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.CULL_FACE);

        // ground shadow
        var lowY = slabs[0].y - 0.6;
        var sh = M4.mul(M4.translate(0, Math.min(lowY, -1.55) - 0.35 + (state.explode < 0.5 ? 0 : 0), 0), M4.mul(M4.rotX(-Math.PI / 2), M4.scale(4.6, 3.6, 1)));
        gl.useProgram(sprog);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniformMatrix4fv(SU.uMVP, false, M4.mul(VP, sh));
        gl.uniform1f(SU.uAlpha, 0.26 * (0.5 + 0.5 * slabs[0].intro));
        bindMesh(GEO.shadowQuad || (GEO.shadowQuad = upload((function () { var q = newMesh(); quad(q, [-0.5,-0.5,0], [0.5,-0.5,0], [0.5,0.5,0], [-0.5,0.5,0], [0,0,1]); return q; })())),
            { p: A.spos, n: A.snrm, u: A.suv });
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.BLEND);

        gl.useProgram(prog);
        gl.enable(gl.DEPTH_TEST);
        setCommon();
        slabs.forEach(function (s, i) {
            var fade = Math.max(s.fade, (1 - s.intro) * 0.9);
            drawPart(GEO.slab, s.model, {
                texA: s.texA, texB: s.texB, mix: s.mix, fade: fade, color: [1, 1, 1], spec: 0.35, shiny: 60,
                rim: 0.38 * s.mix + 0.3 * s.hover, rimCol: ACCENT
            });
            drawSlabParts(s, t, fade, s.mix);
        });

        // labels follow the slabs
        var lo = clamp(smooth(0.55, 0.95, state.explode), 0, 1) * presence;
        slabs.forEach(function (s, i) {
            var p = M4.apply(M4.mul(VP, s.model), W / 2 - 0.4, TOP, D / 2 - 0.02, 1);
            var lab = labels[i];
            if (p[3] <= 0) { lab.style.visibility = 'hidden'; return; }
            var sx = (p[0] / p[3] * 0.5 + 0.5) * state.w + cr.left, sy = (1 - (p[1] / p[3] * 0.5 + 0.5)) * state.h + cr.top;
            lab.style.visibility = lo > 0.05 ? 'visible' : 'hidden';
            lab.style.opacity = lo.toFixed(3);
            lab.style.transform = 'translate3d(' + Math.round(sx) + 'px,' + Math.round(sy) + 'px,0)';
            lab.classList.toggle('is-active', state.active === i);
            lab.classList.toggle('is-hover', state.hover === i);
        });

        if (!state.ready && slabs[3].intro >= 1) { state.ready = true; root.classList.add('stage-ready'); }
    }

    /* ---------- boot ---------- */
    var rafId = 0, last = performance.now();
    collect(); resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { cancelAnimationFrame(rafId); rafId = 0; }
        else if (!rafId) { last = performance.now(); rafId = requestAnimationFrame(frame); }
    });
    root.classList.add('has-webgl');
    rafId = requestAnimationFrame(frame);
})();
