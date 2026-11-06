'use client';

import { useEffect, useRef } from 'react';

const vertexSource = `
  attribute vec2 p;
  varying vec2 uv;
  void main() { uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }
`;

// The green ribbon from the approved landing, scaled to the entrance panel.
const fragmentSource = `
  precision mediump float;
  varying vec2 uv;
  uniform float t;
  void main() {
    float wave = sin(uv.x * 6. + uv.y * 3. + t * .65) * .20;
    float distanceToRibbon = (uv.x - .48 - wave) / .23;
    float ribbon = exp(-distanceToRibbon * distanceToRibbon);
    float glow = .5 + .5 * sin(uv.x * 5. - uv.y * 4. + t * .55);
    vec3 color = mix(vec3(.075, .14, .105), vec3(.30, .40, .19),
      ribbon * (.4 + .6 * glow));
    gl_FragColor = vec4(color, 1.);
  }
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

export function BrandAmbient() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext('webgl', { alpha: true, antialias: false });
    if (!canvas || !gl) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const release = () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };

    if (!vertex || !fragment || !program || !buffer) {
      release();
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      release();
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const time = gl.getUniformLocation(program, 't');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let visible = false;

    const draw = (timestamp: number) => {
      const width = Math.min(840, canvas.clientWidth);
      const height = Math.min(600, canvas.clientHeight);
      if (!visible || document.hidden || gl.isContextLost() || width === 0 || height === 0) return;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform1f(time, reducedMotion.matches ? 0 : timestamp / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!reducedMotion.matches) frame = requestAnimationFrame(draw);
    };

    function refresh() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    }

    const resize = new ResizeObserver(refresh);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      refresh();
    });
    resize.observe(canvas);
    intersection.observe(canvas);
    reducedMotion.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      reducedMotion.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', refresh);
      release();
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />;
}
