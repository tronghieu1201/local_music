/* A transparent petal layer inspired by the Sakura WebGL demo. */
(() => {
    'use strict';

    if (window.__soundKerSakura) return;
    let canvas = document.getElementById('sakura-background');
    if (!canvas) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const abort = new AbortController();
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 96;
    const painter = sprite.getContext('2d');
    if (!painter) return;

    // One reusable, softly shaded petal; each instance is rotated in three axes.
    const shade = painter.createLinearGradient(22, 16, 70, 82);
    shade.addColorStop(0, '#fff0ed');
    shade.addColorStop(0.48, '#f5c6ca');
    shade.addColorStop(1, '#d98f9e');
    painter.beginPath();
    painter.moveTo(48, 85);
    painter.bezierCurveTo(30, 77, 14, 57, 18, 35);
    painter.bezierCurveTo(20, 19, 33, 9, 43, 17);
    painter.quadraticCurveTo(48, 23, 51, 18);
    painter.bezierCurveTo(63, 8, 78, 20, 78, 35);
    painter.bezierCurveTo(79, 56, 65, 76, 48, 85);
    painter.closePath();
    painter.fillStyle = shade;
    painter.fill();
    painter.beginPath();
    painter.moveTo(48, 82);
    painter.quadraticCurveTo(43, 58, 48, 31);
    painter.strokeStyle = 'rgba(171, 90, 108, .16)';
    painter.lineWidth = 1;
    painter.stroke();

    let renderer = null;
    let frame = 0;
    let lastPaint = 0;
    let width = 1;
    let height = 1;
    let ratio = 1;
    let smallScreen = false;
    let resizePending = true;
    let suspendedForPage = false;
    let destroyed = false;
    let petals = [];
    const quadCorners = [
        [-1, -1, 0, 0], [1, -1, 1, 0], [-1, 1, 0, 1],
        [-1, 1, 0, 1], [1, -1, 1, 0], [1, 1, 1, 1]
    ];

    const random = (min, max) => min + Math.random() * (max - min);

    function makePetal(initial = false) {
        const depth = random(0, 1);
        return {
            x: random(-width * 0.1, width * 1.1),
            y: initial ? random(-height * 0.1, height * 1.1) : random(-75, -20),
            depth,
            size: random(8, 13) + depth * 8,
            fall: random(11, 21) + depth * 15,
            drift: random(-11, 11),
            sway: random(4, 17),
            phase: random(0, Math.PI * 2),
            wobble: random(0.45, 1.05),
            rotation: random(0, Math.PI * 2),
            spin: random(-0.5, 0.5),
            tilt: random(0, Math.PI * 2),
            tiltSpeed: random(0.45, 1.0),
            opacity: random(0.3, 0.52) * (0.65 + depth * 0.35)
        };
    }

    function compile(gl, kind, source) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error('Shader allocation failed');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            throw new Error('Shader compilation failed');
        }
        return shader;
    }

    function createWebGL(target) {
        let gl;
        try {
            gl = target.getContext('webgl', {
                alpha: true, premultipliedAlpha: true, antialias: false,
                depth: false, stencil: false, powerPreference: 'low-power'
            });
        } catch {
            return null;
        }
        if (!gl) return null;
        let program, buffer, texture, vertex, fragment;
        try {
            vertex = compile(gl, gl.VERTEX_SHADER, `
                attribute vec2 a_position;
                attribute vec2 a_uv;
                attribute float a_opacity;
                uniform vec2 u_resolution;
                varying vec2 v_uv;
                varying float v_opacity;
                void main() {
                    vec2 clip = a_position / u_resolution * 2.0 - 1.0;
                    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
                    v_uv = a_uv;
                    v_opacity = a_opacity;
                }
            `);
            fragment = compile(gl, gl.FRAGMENT_SHADER, `
                precision mediump float;
                uniform sampler2D u_texture;
                varying vec2 v_uv;
                varying float v_opacity;
                void main() {
                    vec4 petal = texture2D(u_texture, v_uv);
                    float alpha = petal.a * v_opacity;
                    gl_FragColor = vec4(petal.rgb * alpha, alpha);
                }
            `);
            program = gl.createProgram();
            if (!program) throw new Error('Program allocation failed');
            gl.attachShader(program, vertex);
            gl.attachShader(program, fragment);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program linking failed');
            gl.deleteShader(vertex);
            gl.deleteShader(fragment);
            vertex = fragment = null;
            buffer = gl.createBuffer();
            texture = gl.createTexture();
            if (!buffer || !texture) throw new Error('Buffer allocation failed');
            gl.useProgram(program);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            const vertices = new Float32Array(64 * 30);
            gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
            const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
            [['a_position', 2, 0], ['a_uv', 2, 2], ['a_opacity', 1, 4]].forEach(([name, size, offset]) => {
                const location = gl.getAttribLocation(program, name);
                gl.enableVertexAttribArray(location);
                gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
            });
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sprite);
            gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
            const resolution = gl.getUniformLocation(program, 'u_resolution');
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.clearColor(0, 0, 0, 0);

            return {
                kind: 'webgl',
                resize() {
                    gl.viewport(0, 0, target.width, target.height);
                    gl.uniform2f(resolution, width, height);
                },
                draw(shapes) {
                    let index = 0;
                    for (const p of shapes) {
                        for (const [sx, sy, u, v] of quadCorners) {
                            vertices[index++] = p.x + sx * p.ax + sy * p.bx;
                            vertices[index++] = p.y + sx * p.ay + sy * p.by;
                            vertices[index++] = u;
                            vertices[index++] = v;
                            vertices[index++] = p.opacity;
                        }
                    }
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices.subarray(0, index));
                    gl.drawArrays(gl.TRIANGLES, 0, shapes.length * 6);
                },
                clear() { gl.clear(gl.COLOR_BUFFER_BIT); },
                dispose() {
                    gl.deleteTexture(texture);
                    gl.deleteBuffer(buffer);
                    gl.deleteProgram(program);
                    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
                }
            };
        } catch {
            if (vertex) gl.deleteShader(vertex);
            if (fragment) gl.deleteShader(fragment);
            if (buffer) gl.deleteBuffer(buffer);
            if (texture) gl.deleteTexture(texture);
            if (program) gl.deleteProgram(program);
            if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
            return null;
        }
    }

    function create2D(target) {
        const ctx = target.getContext('2d', { alpha: true });
        if (!ctx) return null;
        return {
            kind: '2d',
            resize() {},
            draw(shapes) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, target.width, target.height);
                for (const p of shapes) {
                    ctx.setTransform(p.ax * ratio, p.ay * ratio, p.bx * ratio, p.by * ratio, p.x * ratio, p.y * ratio);
                    ctx.globalAlpha = p.opacity;
                    ctx.drawImage(sprite, -1, -1, 2, 2);
                }
                ctx.globalAlpha = 1;
            },
            clear() {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, target.width, target.height);
            },
            dispose() { this.clear(); }
        };
    }

    function replaceCanvas() {
        const replacement = canvas.cloneNode(false);
        canvas.replaceWith(replacement);
        canvas = replacement;
    }

    function useFallback() {
        canvas.removeEventListener('webglcontextlost', onContextLost);
        if (renderer) renderer.dispose();
        replaceCanvas();
        renderer = create2D(canvas);
        resizePending = true;
    }

    function onContextLost(event) {
        event.preventDefault();
        if (destroyed) return;
        useFallback();
        if (!renderer) stop();
        else sync();
    }

    function initializeRenderer() {
        renderer = createWebGL(canvas);
        if (renderer) {
            canvas.addEventListener('webglcontextlost', onContextLost);
        } else {
            // A canvas that acquired WebGL cannot subsequently acquire 2D.
            replaceCanvas();
            renderer = create2D(canvas);
        }
        return Boolean(renderer);
    }

    function resize() {
        width = Math.max(1, window.innerWidth);
        height = Math.max(1, window.innerHeight);
        smallScreen = width <= 768;
        ratio = Math.min(window.devicePixelRatio || 1, smallScreen ? 1 : 1.5);
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        renderer.resize();
        const count = smallScreen
            ? Math.min(24, Math.max(14, Math.round(width * height / 18000)))
            : Math.min(64, Math.max(28, Math.round(width * height / 23000)));
        while (petals.length < count) petals.push(makePetal(true));
        if (petals.length > count) petals.length = count;
        petals.sort((a, b) => a.depth - b.depth);
        resizePending = false;
    }

    function stop() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        lastPaint = 0;
    }

    function tick(now) {
        frame = 0;
        if (destroyed || document.hidden || motion.matches || suspendedForPage || !renderer) return;
        if (resizePending) resize();
        const minimumInterval = smallScreen ? 32 : 15.5;
        if (lastPaint && now - lastPaint < minimumInterval) {
            frame = requestAnimationFrame(tick);
            return;
        }
        const dt = lastPaint ? Math.min((now - lastPaint) / 1000, 0.05) : 0;
        lastPaint = now;
        for (let index = 0; index < petals.length; index++) {
            let p = petals[index];
            p.phase += p.wobble * dt;
            p.rotation += p.spin * dt;
            p.tilt += p.tiltSpeed * dt;
            p.x += (p.drift + Math.sin(p.phase) * p.sway) * dt;
            p.y += p.fall * dt;
            if (p.y > height + 50) petals[index] = p = makePetal();
            if (p.x < -70) p.x = width + 65;
            if (p.x > width + 70) p.x = -65;
            const cos = Math.cos(p.rotation);
            const sin = Math.sin(p.rotation);
            const fold = Math.cos(p.tilt);
            const pitch = 0.65 + 0.35 * Math.cos(p.tilt * 0.7);
            p.ax = cos * p.size * fold;
            p.ay = sin * p.size * fold;
            p.bx = -sin * p.size * pitch;
            p.by = cos * p.size * pitch;
        }
        renderer.draw(petals);
        frame = requestAnimationFrame(tick);
    }

    function sync() {
        if (destroyed) return;
        if (document.hidden || motion.matches || suspendedForPage) {
            stop();
            if (motion.matches && renderer) renderer.clear();
            return;
        }
        if (!renderer && !initializeRenderer()) return;
        if (!frame) frame = requestAnimationFrame(tick);
    }

    window.addEventListener('resize', () => { resizePending = true; }, { passive: true, signal: abort.signal });
    document.addEventListener('visibilitychange', sync, { signal: abort.signal });
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) { suspendedForPage = true; stop(); }
        else window.__soundKerSakura?.destroy();
    }, { signal: abort.signal });
    window.addEventListener('pageshow', () => { suspendedForPage = false; sync(); }, { signal: abort.signal });
    motion.addEventListener('change', sync);

    window.__soundKerSakura = {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            stop();
            abort.abort();
            motion.removeEventListener('change', sync);
            canvas.removeEventListener('webglcontextlost', onContextLost);
            renderer?.dispose();
            renderer = null;
            petals = [];
            canvas.remove();
            delete window.__soundKerSakura;
        }
    };
    sync();
})();
