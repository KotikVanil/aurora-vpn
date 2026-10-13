// Full-window WebGL aurora. Energy follows connection state and live traffic.

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 res;
uniform float t;
uniform float energy;   // 0 idle .. 1 connected
uniform float pulse;    // traffic spikes
uniform vec3 c1;
uniform vec3 c2;
uniform vec3 c3;
uniform float warp;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float speed = 0.04 + 0.10 * energy + 0.25 * pulse + warp * 0.8;
  float tt = t * speed;

  vec3 col = vec3(0.016, 0.02, 0.045);
  // stars
  vec2 sp = gl_FragCoord.xy / 2.0;
  float s = hash(floor(sp));
  float tw = 0.5 + 0.5 * sin(t * 2.0 + s * 50.0);
  col += vec3(0.8, 0.9, 1.0) * step(0.9975, s) * tw * 0.7;

  // aurora curtains
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float y = 0.18 + fi * 0.12 + 0.12 * fbm(vec2(p.x * 1.4 + tt * (0.6 + fi * 0.3) + fi * 7.0, tt * 0.5));
    float band = exp(-pow((uv.y - 0.38 - y * 0.6) * (5.0 - fi), 2.0) * 6.0);
    float rays = fbm(vec2(p.x * 7.0 + fi * 3.0 + tt * 1.6, uv.y * 1.5 - tt));
    band *= 0.45 + 0.75 * rays;
    vec3 c = i == 0 ? c1 : (i == 1 ? c2 : c3);
    float amp = mix(0.10, 0.42, energy) + pulse * 0.25;
    col += c * band * amp * smoothstep(0.0, 0.5, uv.y);
  }
  // horizon glow
  col += mix(c2, c1, uv.x) * exp(-uv.y * 3.5) * (0.06 + 0.10 * energy);
  // vignette
  col *= 1.0 - 0.55 * dot(p * 0.9, p * 0.9);
  col = 1.0 - exp(-col * 1.6);
  gl_FragColor = vec4(col, 1.0);
}`;

export const PALETTES = {
  aurora: [[0.16, 0.95, 0.72], [0.35, 0.45, 1.0], [0.85, 0.3, 1.0]],
  sunset: [[1.0, 0.55, 0.25], [1.0, 0.25, 0.5], [0.55, 0.25, 1.0]],
  matrix: [[0.2, 1.0, 0.45], [0.1, 0.7, 0.35], [0.6, 1.0, 0.3]],
  ice: [[0.5, 0.85, 1.0], [0.3, 0.55, 1.0], [0.85, 0.95, 1.0]],
};
const IDLE = [[0.35, 0.42, 0.6], [0.25, 0.3, 0.5], [0.4, 0.35, 0.6]];

export function startAurora(canvas) {
  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  const state = { energy: 0, targetEnergy: 0, pulse: 0, warp: 0, palette: PALETTES.aurora, mix: 0 };
  if (!gl) return state;

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n) => gl.getUniformLocation(prog, n);
  const U = { res: u("res"), t: u("t"), energy: u("energy"), pulse: u("pulse"), c1: u("c1"), c2: u("c2"), c3: u("c3"), warp: u("warp") };

  const scale = 0.5; // render at half resolution: soft look, cheap GPU
  const resize = () => {
    canvas.width = Math.max(1, Math.floor(innerWidth * scale));
    canvas.height = Math.max(1, Math.floor(innerHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  addEventListener("resize", resize);
  resize();

  const start = performance.now();
  let last = start;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) {
      state.energy += (state.targetEnergy - state.energy) * Math.min(1, dt * 1.5);
      state.pulse *= Math.pow(0.2, dt);
      state.warp *= Math.pow(0.35, dt);
      const e = state.energy;
      const c = (i) => IDLE[i].map((v, k) => v + (state.palette[i][k] - v) * Math.min(1, e * 1.4));
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform1f(U.t, (now - start) / 1000);
      gl.uniform1f(U.energy, e);
      gl.uniform1f(U.pulse, Math.min(1, state.pulse));
      gl.uniform1f(U.warp, state.warp);
      gl.uniform3fv(U.c1, c(0));
      gl.uniform3fv(U.c2, c(1));
      gl.uniform3fv(U.c3, c(2));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return state;
}
