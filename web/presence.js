// Accumulation of Presence — renderer shared by the exhibition TV and the website.
// The server sends only a compact world state; every structure here is grown
// deterministically from seeds, so every screen shows the same creature.
import * as THREE from './vendor/three.module.min.js';

const API = (window.PRESENCE_API || '/api').replace(/\/$/, '');
const W = 1.78;
const qs = new URLSearchParams(location.search);
const TV = qs.has('tv');
const SEG_BUDGET = TV ? 60000 : 42000;
if (TV) document.body.classList.add('tv');
if (qs.has('clean')) document.body.classList.add('clean');
if (TV) document.body.style.cursor = 'none';

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x030305, 1);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);

const U = {
  uT: { value: 0 }, uClock: { value: 0 }, uPx: { value: 1 }, uGain: { value: 1 },
  uDrift: { value: 0 }, uVolume: { value: 0 }, uWave: { value: 0 }, uComplex: { value: 0 }, uEmerge: { value: 0 },
  uBodies: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uBodyG: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uPulses: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
};

function resize() {
  const w = window.innerWidth, h = window.innerHeight, a = w / h;
  renderer.setSize(w, h, false);
  const halfH = Math.max(1.06, (W * 1.04) / a), halfW = halfH * a;
  camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
  camera.updateProjectionMatrix();
  U.uPx.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / 1000 * (1.06 / halfH);
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------- shaders
const NOISE = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0); m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0; vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw; return 130.0*dot(m,g);
}`;

const FIELD = /* glsl */`
uniform float uT, uClock, uDrift, uVolume, uWave, uComplex, uEmerge, uPx, uGain;
uniform vec4 uBodies[8]; uniform vec4 uBodyG[8]; uniform vec4 uPulses[8];
${NOISE}
// live people bend the memory around them; arrivals send waves through it
vec2 field(vec2 p, float seed, float amp, out float glow){
  glow = 0.0; vec2 q = p; float calm = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 b = uBodies[i];
    if (b.z < 0.5) continue;
    vec4 g = uBodyG[i];
    vec2 d = p - b.xy; float r = length(d) + 1e-4; vec2 n = d / r;
    float f = exp(-r * r / 0.12) * b.w;
    q += n * 0.03 * f;                                   // presence pushes softly
    q.y += 0.24 * f * g.x;                               // hands up: drawn upwards
    q += n * 0.22 * f * g.y;                             // arms open: the network steps back
    float ring = r - fract(uClock * 0.7 + float(i) * 0.37) * 1.5;
    q += n * 0.06 * exp(-ring * ring / 0.004) * g.w * exp(-r * 0.7) * b.w;  // fast: a wave
    calm = max(calm, exp(-r * r / 0.3) * g.z * b.w);     // stillness: everything calms
    glow += f * 0.9;
  }
  for (int i = 0; i < 8; i++) {
    vec4 P = uPulses[i];
    float age = uClock - P.z;
    if (P.w <= 0.0 || age < 0.0 || age > 12.0) continue;
    vec2 d = p - P.xy; float r = length(d) + 1e-4;
    float ring = r - age * (0.22 + 0.3 * uWave);
    float w = exp(-ring * ring / 0.003) * exp(-age * 0.38) * P.w;
    q += d / r * 0.03 * w * (0.4 + uWave);
    glow += w * (0.5 + uWave * 1.6);
  }
  float a = amp * (1.0 - calm * 0.85);
  float t = uT * 0.025;
  q += vec2(snoise(p * 1.3 + vec2(seed, t)), snoise(p * 1.3 + vec2(t, seed + 7.1))) * a;
  q += vec2(snoise(p * 4.1 + vec2(t * 2.0, seed)), snoise(p * 4.1 + vec2(seed + 3.0, -t * 2.0))) * a * 0.3 * (0.4 + uComplex);
  return q;
}`;

const LINE_VS = /* glsl */`
${FIELD}
uniform float uAmp;
attribute vec4 aInfo;    // seed, t along, depth/age, visibility
attribute vec2 aCenter;
attribute float aBorn;
varying vec4 vInfo; varying float vGlow; varying float vFresh;
void main(){
  vec2 p = position.xy;
  p = aCenter + (p - aCenter) * (1.0 + uVolume * 0.035 * sin(uT * 0.35 + aInfo.x * 6.283));
  float glow;
  p = field(p, aInfo.x * 17.0, uAmp * (0.35 + aInfo.z), glow);
  vInfo = aInfo; vGlow = glow; vFresh = exp(-max(0.0, uClock - aBorn) / 16.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

const LINE_FS = /* glsl */`
uniform vec3 uColA, uColB, uColC; uniform float uAlpha, uClock, uGain;
varying vec4 vInfo; varying float vGlow; varying float vFresh;
void main(){
  float seed = vInfo.x, t = vInfo.y, depth = vInfo.z, vis = vInfo.w;
  vec3 col = mix(uColA, uColB, fract(seed * 7.31));
  col = mix(col, uColC, depth * 0.75);
  float flick = 0.72 + 0.28 * sin(t * 19.0 - uClock * 0.45 + seed * 40.0);
  float a = uAlpha * uGain * vis * flick * (1.0 + vGlow * 1.3 + vFresh * 3.5);
  gl_FragColor = vec4(col * (1.0 + vFresh * 0.6), min(a, 1.0));
}`;

const POINT_VS = /* glsl */`
${FIELD}
uniform float uAmp;
attribute vec4 aInfo;    // seed, size, depth, visibility
attribute vec2 aCenter;
attribute float aBorn;
varying vec4 vInfo; varying float vGlow;
void main(){
  vec2 p = position.xy;
  p = aCenter + (p - aCenter) * (1.0 + uVolume * 0.04 * sin(uT * 0.35 + aInfo.x * 6.283));
  float glow;
  p = field(p, aInfo.x * 17.0, uAmp * (0.4 + aInfo.z), glow);
  vInfo = aInfo; vGlow = glow;
  gl_PointSize = aInfo.y * uPx * (1.0 + glow * 0.4);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

const POINT_FS = /* glsl */`
uniform vec3 uColA, uColB, uColC; uniform float uAlpha, uClock, uGain;
varying vec4 vInfo; varying float vGlow;
void main(){
  vec2 c = gl_PointCoord - 0.5; float d = length(c) * 2.0;
  if (d > 1.0) discard;
  vec3 col = mix(uColA, uColB, fract(vInfo.x * 5.17));
  col = mix(col, uColC, vInfo.z * 0.7);
  float tw = 0.75 + 0.25 * sin(uClock * 0.6 + vInfo.x * 50.0);
  float a = exp(-d * d * 4.0) * uAlpha * uGain * vInfo.w * tw * (1.0 + vGlow);
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

const c3 = (r, g, b) => new THREE.Color(r, g, b);
function makeMat(kind, vs, fs, colors, alpha, amp) {
  return new THREE.ShaderMaterial({
    vertexShader: vs, fragmentShader: fs,
    uniforms: { ...U, uColA: { value: colors[0] }, uColB: { value: colors[1] }, uColC: { value: colors[2] },
      uAlpha: { value: alpha }, uAmp: { value: amp } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
const MAT = {
  threads: makeMat('l', LINE_VS, LINE_FS, [c3(.78, .86, .92), c3(.96, .86, .70), c3(.32, .52, .78)], 0.2, 0.006),
  veins: makeMat('l', LINE_VS, LINE_FS, [c3(.97, .72, .46), c3(.86, .44, .52), c3(.26, .66, .78)], 0.11, 0.012),
  tissue: makeMat('l', LINE_VS, LINE_FS, [c3(.52, .72, .96), c3(.96, .80, .62), c3(.62, .48, .92)], 0.07, 0.02),
  nodes: makeMat('p', POINT_VS, POINT_FS, [c3(1, .9, .74), c3(.9, .95, 1), c3(.5, .7, 1)], 0.55, 0.012),
  haze: makeMat('p', POINT_VS, POINT_FS, [c3(.55, .38, .55), c3(.25, .45, .62), c3(.7, .5, .35)], 0.035, 0.03),
};

// ------------------------------------------------------------------ builders
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class Buf {
  constructor(points) { this.points = points; this.pos = []; this.info = []; this.center = []; this.born = []; this.n = 0; }
  v(x, y, i0, i1, i2, i3, cx, cy, born) {
    this.pos.push(x, y, 0); this.info.push(i0, i1, i2, i3); this.center.push(cx, cy); this.born.push(born); this.n++;
  }
  seg(x1, y1, x2, y2, seed, t1, t2, depth, vis, cx, cy, born = -1e4) {
    this.v(x1, y1, seed, t1, depth, vis, cx, cy, born); this.v(x2, y2, seed, t2, depth, vis, cx, cy, born);
  }
  object(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('aCenter', new THREE.Float32BufferAttribute(this.center, 2));
    g.setAttribute('aBorn', new THREE.Float32BufferAttribute(this.born, 1));
    const o = this.points ? new THREE.Points(g, mat) : new THREE.LineSegments(g, mat);
    o.frustumCulled = false;
    return o;
  }
}

function catmull(p, i, t) {
  const n = p.length / 2, g = k => Math.min(n - 1, Math.max(0, k));
  const a = g(i - 1), b = g(i), c = g(i + 1), d = g(i + 2);
  const f = (k0, k1, k2, k3) => 0.5 * ((2 * k1) + (-k0 + k2) * t + (2 * k0 - 5 * k1 + 4 * k2 - k3) * t * t + (-k0 + 3 * k1 - 3 * k2 + k3) * t * t * t);
  return [f(p[a * 2], p[b * 2], p[c * 2], p[d * 2]), f(p[a * 2 + 1], p[b * 2 + 1], p[c * 2 + 1], p[d * 2 + 1])];
}

function bezierStrand(buf, ax, ay, bx, by, kx, ky, steps, seed, depth, vis, cx, cy, born) {
  let px = ax, py = ay;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps, u = 1 - t;
    const x = u * u * ax + 2 * u * t * kx + t * t * bx, y = u * u * ay + 2 * u * t * ky + t * t * by;
    const taper = Math.min(1, t * 4, (1 - t + 1 / steps) * 4);
    buf.seg(px, py, x, y, seed, t - 1 / steps, t, depth, vis * taper, cx, cy, born);
    px = x; py = y;
  }
}

const bornAt = new Map();   // thread id -> clock time first seen (for the birth glow)
let firstLoad = true;

function buildThreads(all, day) {
  // later days: individual traces dissolve into the structures (complexity, not noise)
  const threads = all.slice(-Math.round(320 - 28 * (day - 1)));
  const buf = new Buf(false), n = threads.length;
  threads.forEach((t, idx) => {
    const age = n > 1 ? 1 - idx / (n - 1) : 0;
    if (!bornAt.has(t.i)) bornAt.set(t.i, firstLoad ? -1e4 : U.uClock.value);
    const born = bornAt.get(t.i), p = t.p, m = p.length / 2;
    const seed = (t.s % 1000) / 1000, sub = 4, total = (m - 1) * sub;
    let prev = [p[0], p[1]], k = 0;
    for (let i = 0; i < m - 1; i++) {
      for (let s = 1; s <= sub; s++) {
        const q = catmull(p, i, s / sub); k++;
        const tt = k / total, taper = Math.min(1, tt * 5, (1 - tt) * 5 + 0.2);
        buf.seg(prev[0], prev[1], q[0], q[1], seed, (k - 1) / total, tt, age, (1 - age * 0.55) * taper, 0, 0, born);
        prev = q;
      }
    }
  });
  return buf.object(MAT.threads);
}

function buildStructures(st) {
  const P = st.params, veins = new Buf(false), tissue = new Buf(false), nodes = new Buf(true), haze = new Buf(true);
  const clusters = st.clusters.filter(c => c.m >= 2);
  const cent = new Map();
  for (const c of st.clusters) {
    let x = 0, y = 0; const k = c.n.length / 2;
    for (let i = 0; i < k; i++) { x += c.n[i * 2]; y += c.n[i * 2 + 1]; }
    cent.set(c.i, [x / k, y / k]);
  }
  const connect = Math.max(P.connect, 0.12 * P.drift);   // day 2: memories start to touch
  const sumSqrt = clusters.reduce((s, c) => s + Math.sqrt(c.m), 0) || 1;

  for (const c of clusters) {
    const vis = connect * smooth(1, 6, c.m) * (1 + P.volume * 0.6 + P.emergence * 0.3);
    if (vis < 0.01) continue;
    const rnd = mulberry32(c.s * 7919 + c.i * 31);
    const [cx, cy] = cent.get(c.i), seed = (c.s % 997) / 997;
    const massF = Math.log2(1 + c.m);
    let budget = SEG_BUDGET * Math.sqrt(c.m) / sumSqrt;
    const N = c.n, L = c.l, nn = N.length / 2;
    const deg = new Array(nn).fill(0);
    // 1. connections: braided strands along the links
    const strands = 1 + Math.floor(P.complexity * 2 + P.volume + P.emergence);
    for (let i = 0; i < L.length; i += 2) {
      const a = L[i], b = L[i + 1]; if (a >= nn || b >= nn) continue;
      deg[a]++; deg[b]++;
      const ax = N[a * 2], ay = N[a * 2 + 1], bx = N[b * 2], by = N[b * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1e-3, px = -(by - ay) / len, py = (bx - ax) / len;
      for (let s = 0; s < strands; s++) {
        const off = (rnd() - 0.5) * len * (0.35 + 0.5 * P.complexity);
        bezierStrand(veins, ax, ay, bx, by, (ax + bx) / 2 + px * off, (ay + by) / 2 + py * off,
          8, seed + s * 0.13, 0.15, vis * 0.9, cx, cy);
        budget -= 8;
      }
    }
    // 2. growth: roots / dendrites / coral from every node (breadth first, budgeted)
    const maxDepth = 1 + Math.round(1.4 * connect + P.volume + P.complexity * 1.2 + P.emergence);
    const baseLen = 0.03 + 0.02 * massF * (0.6 + 0.6 * P.volume);
    const queue = [];
    for (let i = 0; i < nn; i++) {
      const nx = N[i * 2], ny = N[i * 2 + 1];
      const nb = Math.floor(rnd() * (1 + massF * 0.45 * connect + P.volume * 1.5 + P.complexity * 2));
      for (let b = 0; b < nb; b++) {
        queue.push([nx, ny, Math.atan2(ny - cy, nx - cx) + (rnd() - 0.5) * 2.2, baseLen * (0.6 + rnd() * 0.8), 0]);
      }
      // nodes: points of light, larger where many paths met
      nodes.v(nx, ny, seed + i * 0.01, 1.6 + Math.min(6, deg[i]) * 0.7 + P.volume * 2.5, 0.1, vis, cx, cy, -1e4);
    }
    let qi = 0;
    while (qi < queue.length && budget > 0) {
      let [x, y, ang, len, depth] = queue[qi++];
      const steps = 5, dn = depth / Math.max(1, maxDepth);
      for (let s = 0; s < steps; s++) {
        ang += (rnd() - 0.5) * 0.75;
        const nx = x + Math.cos(ang) * len / steps, ny = y + Math.sin(ang) * len / steps;
        veins.seg(x, y, nx, ny, seed, s / steps, (s + 1) / steps, 0.25 + dn * 0.75, vis * (1 - dn * 0.55), cx, cy);
        budget--;
        if (P.volume > 0 && rnd() < P.volume * 0.22) {
          const r = 0.006 + 0.03 * rnd() * (1 - dn);
          haze.v(nx + (rnd() - 0.5) * r * 2, ny + (rnd() - 0.5) * r * 2, seed + rnd(), 6 + 26 * rnd() * P.volume, dn, vis, cx, cy, -1e4);
        }
        x = nx; y = ny;
      }
      if (depth < maxDepth) {
        const kids = rnd() < 0.4 + 0.25 * P.complexity ? 2 : 1;
        for (let k = 0; k < kids; k++) {
          queue.push([x, y, ang + (k === 0 ? 1 : -1) * (0.35 + rnd() * 0.7), len * (0.62 + rnd() * 0.15), depth + 1]);
        }
      }
    }
    // 3. volume: a soft body around the structure
    if (P.volume > 0) {
      const count = Math.floor(P.volume * (8 + massF * 14));
      for (let i = 0; i < count; i++) {
        const j = Math.floor(rnd() * nn), r = 0.02 + 0.08 * rnd() * (0.5 + P.volume);
        const a = rnd() * 6.283;
        haze.v(N[j * 2] + Math.cos(a) * r, N[j * 2 + 1] + Math.sin(a) * r * 0.8, seed + rnd(), 30 + 80 * rnd() * P.volume, 0.5, vis * 0.8, cx, cy, -1e4);
      }
    }
  }

  // 4. organisms: tissue between the clusters of one organism (minimum spanning tree)
  const orgs = st.organisms || [];
  const rnd = mulberry32(4242 + orgs.length);
  for (const o of orgs) {
    const pts = o.c.map(id => cent.get(id)).filter(Boolean);
    if (pts.length < 2 || connect <= 0) continue;
    const inTree = [0], rest = pts.map((_, i) => i).slice(1);
    while (rest.length) {
      let best = null;
      for (const a of inTree) for (const b of rest) {
        const d = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
        if (!best || d < best[0]) best = [d, a, b];
      }
      const [d, a, b] = best;
      inTree.push(b); rest.splice(rest.indexOf(b), 1);
      const n = 2 + Math.floor(3 * P.volume + 4 * P.complexity + 4 * P.emergence);
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const px = -(by - ay) / (d || 1), py = (bx - ax) / (d || 1);
      for (let s = 0; s < n; s++) {
        const off = (rnd() - 0.5) * d * 0.7;
        bezierStrand(tissue, ax, ay, bx, by, (ax + bx) / 2 + px * off, (ay + by) / 2 + py * off, 14, rnd(), 0.4, connect, o.x, o.y);
      }
    }
  }

  // 5. emergence (day 7): every memory reaches the others — one super-organism
  if (P.emergence > 0 && orgs.length) {
    let gx = 0, gy = 0, gm = 0;
    for (const o of orgs) { gx += o.x * o.m; gy += o.y * o.m; gm += o.m; }
    gx /= gm; gy /= gm;
    for (const c of clusters) {
      const [x, y] = cent.get(c.i);
      const d = Math.hypot(x - gx, y - gy) || 1e-3;
      const n = 1 + Math.floor(Math.log2(1 + c.m));
      for (let s = 0; s < n; s++) {
        const sw = (rnd() < 0.5 ? 1 : -1) * (0.25 + rnd() * 0.45);
        const kx = (x + gx) / 2 - (y - gy) * sw, ky = (y + gy) / 2 + (x - gx) * sw;
        bezierStrand(tissue, x, y, gx + (rnd() - 0.5) * 0.06, gy + (rnd() - 0.5) * 0.06, kx, ky, 18, rnd(), 0.6, 0.8, gx, gy);
      }
    }
    for (let i = 0; i < 500; i++) {
      const a = rnd() * 6.283, r = 0.04 + Math.pow(rnd(), 1.4) * 0.55;
      haze.v(gx + Math.cos(a) * r * 1.6, gy + Math.sin(a) * r, rnd(), 6 + 34 * rnd(), Math.min(1, r * 2), 0.35, gx, gy, -1e4);
    }
  }

  return [tissue.object(MAT.tissue), veins.object(MAT.veins), haze.object(MAT.haze), nodes.object(MAT.nodes)];
}

// ---------------------------------------------------------------- live layer
const LIVE_MAX = 8, AURA = 160, LINK_SEG = 7 * 24;
const auraGeo = new THREE.BufferGeometry();
const auraPos = new Float32Array(LIVE_MAX * AURA * 3), auraA = new Float32Array(LIVE_MAX * AURA);
auraGeo.setAttribute('position', new THREE.BufferAttribute(auraPos, 3));
auraGeo.setAttribute('aA', new THREE.BufferAttribute(auraA, 1));
const auraMat = new THREE.ShaderMaterial({
  uniforms: { uPx: U.uPx },
  vertexShader: `attribute float aA; varying float vA; uniform float uPx;
    void main(){ vA = aA; gl_PointSize = (2.0 + aA * 3.0) * uPx; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard;
    gl_FragColor = vec4(vec3(1.0, 0.92, 0.8), exp(-d * d * 4.0) * vA * 0.5); }`,
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
});
const aura = new THREE.Points(auraGeo, auraMat); aura.frustumCulled = false;
const linkGeo = new THREE.BufferGeometry();
const linkPos = new Float32Array(LIVE_MAX * LIVE_MAX * LINK_SEG * 2 * 3);
linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3));
const linkMat = new THREE.LineBasicMaterial({ color: 0xf2d6a8, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthTest: false });
const links = new THREE.LineSegments(linkGeo, linkMat); links.frustumCulled = false;
const auraSeeds = Array.from({ length: LIVE_MAX * AURA }, (_, i) => { const r = mulberry32(i + 11); return [r() * 6.283, r(), 0.3 + r(), r()]; });

const bodies = new Map();   // id -> smoothed body
function setLive(list) {
  const seen = new Set();
  for (const b of list || []) {
    seen.add(b.i);
    const cur = bodies.get(b.i) || { x: b.x, y: b.y, fade: 0, g: [0, 0, 0, 0] };
    cur.tx = b.x; cur.ty = b.y; cur.tg = [b.hu || 0, b.ao || 0, b.st || 0, b.fa || 0]; cur.alive = true;
    bodies.set(b.i, cur);
  }
  for (const [id, b] of bodies) if (!seen.has(id)) b.alive = false;
}

function updateLive(dt, motion) {
  const arr = [...bodies.entries()];
  for (const [id, b] of arr) {
    b.fade += ((b.alive ? 1 : 0) - b.fade) * Math.min(1, dt * (b.alive ? 2 : 0.8));
    const k = Math.min(1, dt * 6);
    b.x += (b.tx - b.x) * k; b.y += (b.ty - b.y) * k;
    for (let j = 0; j < 4; j++) b.g[j] += (b.tg[j] - b.g[j]) * Math.min(1, dt * 2.5);
    if (!b.alive && b.fade < 0.01) bodies.delete(id);
  }
  const list = [...bodies.values()].slice(0, LIVE_MAX);
  for (let i = 0; i < LIVE_MAX; i++) {
    const b = list[i];
    U.uBodies.value[i].set(b ? b.x : 0, b ? b.y : 0, b ? 1 : 0, b ? b.fade * motion : 0);
    U.uBodyG.value[i].set(...(b ? b.g : [0, 0, 0, 0]));
  }
  // aura: a breathing field, never a figure
  const T = U.uClock.value;
  for (let i = 0; i < LIVE_MAX; i++) {
    const b = list[i];
    for (let j = 0; j < AURA; j++) {
      const k = i * AURA + j, s = auraSeeds[k];
      if (!b) { auraA[k] = 0; continue; }
      const spin = (b.g[2] > 0.5 ? 0.05 : 0.35 + b.g[3] * 1.2) * s[2];
      const a = s[0] + T * spin * (s[3] < 0.5 ? 1 : -1);
      const r = (0.04 + 0.22 * Math.pow(s[1], 0.7)) * (1 + b.g[1] * 0.9) * (1 + 0.15 * Math.sin(T * 0.8 + s[0] * 3));
      auraPos[k * 3] = b.x + Math.cos(a) * r * 0.8;
      auraPos[k * 3 + 1] = b.y + Math.sin(a) * r * 1.2 + b.g[0] * 0.25 * s[1];
      auraA[k] = b.fade * (0.25 + 0.75 * (1 - s[1])) * motion;
    }
  }
  auraGeo.attributes.position.needsUpdate = true; auraGeo.attributes.aA.needsUpdate = true;
  // two people near each other: a connection is born between them
  let v = 0;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > 1.3) continue;
    const str = smooth(1.3, 0.5, d) * Math.min(a.fade, b.fade);
    if (str < 0.02) continue;
    for (let s = 0; s < 7; s++) {
      const off = Math.sin(T * (0.4 + s * 0.13) + s * 2.1) * 0.18 * d;
      const kx = (a.x + b.x) / 2 - (b.y - a.y) * off, ky = (a.y + b.y) / 2 + (b.x - a.x) * off;
      let px = a.x, py = a.y;
      for (let q = 1; q <= 24; q++) {
        const t = q / 24, u = 1 - t;
        const x = u * u * a.x + 2 * u * t * kx + t * t * b.x, y = u * u * a.y + 2 * u * t * ky + t * t * b.y;
        linkPos.set([px, py, 0, x, y, 0], v * 3); v += 2; px = x; py = y;
      }
    }
  }
  linkGeo.setDrawRange(0, v);
  linkGeo.attributes.position.needsUpdate = true;
  linkMat.opacity = 0.1 * motion;
}

// ---------------------------------------------------------------- the world
const layer = { threads: null, structures: [] };
let state = null, mode = 'live', structKey = '', threadKey = '', lastStructBuild = 0, pendingStruct = false;
const target = { drift: 0, volume: 0, wave: 0, complexity: 0, emergence: 0, freeze: 0 };
const pulses = [];
const seenPulse = new Set();
let serverOffset = 0;

function replace(oldObjs, newObjs) {
  for (const o of [].concat(oldObjs || [])) { scene.remove(o); o.geometry.dispose(); }
  for (const o of [].concat(newObjs || [])) scene.add(o);
}

function applyState(st, isSnapshot = false) {
  state = st;
  if (st.now) serverOffset = st.now - Date.now() / 1000;
  Object.assign(target, st.params);
  if (isSnapshot) target.freeze = 1;
  const tk = st.threads.length + ':' + (st.threads[0] || {}).i + ':' + (st.threads.at(-1) || {}).i + ':' + mode;
  if (tk !== threadKey) {
    threadKey = tk;
    const t = buildThreads(st.threads, st.day);
    replace(layer.threads, t); layer.threads = t;
  }
  const sk = [mode, st.clusters.length, st.clusters.reduce((s, c) => s + c.m, 0), (st.organisms || []).length,
    Object.values(st.params).map(v => v.toFixed(2)).join(',')].join('|');
  if (sk !== structKey) { structKey = sk; pendingStruct = true; }
  if (!isSnapshot) {
    for (const p of st.pulses || []) {
      const key = p[3] + ':' + p[0];
      if (seenPulse.has(key)) continue;
      seenPulse.add(key);
      const age = (Date.now() / 1000 + serverOffset) - p[3];
      if (age < 12) pulses.push([p[0], p[1], U.uClock.value - age, p[2]]);
    }
    while (pulses.length > 8) pulses.shift();
    if (st.live && !ws) setLive(st.live);
  }
  firstLoad = false;
  hud();
}

function maybeBuildStructures(now) {
  if (!pendingStruct || !state || now - lastStructBuild < 2.5) return;
  pendingStruct = false; lastStructBuild = now;
  const objs = buildStructures(state);
  replace(layer.structures, objs); layer.structures = objs;
  // structures under threads
  objs.forEach(o => (o.renderOrder = -1));
}

// --------------------------------------------------------------------- data
const url = p => API + p;
let version = -1, ws = null;

async function poll() {
  if (mode !== 'live') return;
  try {
    const r = await fetch(url('/state?live=' + (ws ? 0 : 1) + '&since=' + version), { cache: 'no-store' });
    const st = await r.json();
    if (st.same) return;
    if (!st.threads) return;   // mirror still empty
    version = st.v;
    applyState(st);
  } catch (e) { /* offline: keep living with what we have */ }
}

function connectWS() {
  if (!API.startsWith('/') && !API.startsWith('http')) return;   // PHP host: polling only
  const base = API.startsWith('http') ? new URL(API) : location;
  try {
    const s = new WebSocket((base.protocol === 'https:' ? 'wss://' : 'ws://') + base.host + '/ws');
    s.onopen = () => { ws = s; };
    s.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (mode === 'live' && m.b) setLive(m.b);
      if (m.v !== undefined && m.v !== version && mode === 'live') poll();
    };
    s.onclose = () => { ws = null; setTimeout(connectWS, 4000); };
    s.onerror = () => s.close();
  } catch (e) { /* no websockets */ }
}

async function showSnapshot(key) {
  try {
    const r = await fetch(url('/snapshot/' + key));
    if (!r.ok) return;
    const st = await r.json();
    mode = 'snap:' + key;
    setLive([]);
    firstLoad = true;
    applyState(st, true);
    timeline();
  } catch (e) { /* ignore */ }
}

function goLive() {
  mode = 'live'; version = -1; firstLoad = true;
  poll(); timeline();
}

let snapInfo = { days: [], final: false, live_day: 1 };
async function loadSnapshots() {
  try { snapInfo = await (await fetch(url('/snapshots'), { cache: 'no-store' })).json(); } catch (e) { /* ignore */ }
  timeline();
}

// ---------------------------------------------------------------------- hud
const $ = id => document.getElementById(id);
const fmt = n => (n || 0).toLocaleString('en-US');
function hud() {
  if (!state) return;
  const s = state.stats || {};
  $('stats').innerHTML =
    `VISITORS     <b>${fmt(s.visitors)}</b>\nCONNECTIONS  <b>${fmt(s.connections)}</b>\nMEMORIES     <b>${fmt(s.memories)}</b>\n` +
    `DAY          <b>${state.day} / 7</b>  ${state.phase.toUpperCase()}\nEVOLUTION    <b>${Math.round(state.evolution * 100)}%</b>`;
  $('mode').textContent = mode === 'live' ? (state.frozen ? 'FINAL STATE' : '● LIVE')
    : mode === 'snap:final' ? 'FINAL STATE' : 'ARCHIVE — DAY ' + mode.split(':')[1];
}

function timeline() {
  const el = $('timeline'); el.innerHTML = '';
  const liveDay = snapInfo.live_day || (state && state.day) || 1;
  for (let d = 1; d <= 7; d++) {
    if (d > 1) { const bar = document.createElement('span'); bar.className = 'bar'; el.appendChild(bar); }
    const b = document.createElement('button');
    b.textContent = 'DAY ' + d;
    const has = snapInfo.days.includes(d);
    b.disabled = !has && d !== liveDay;
    if (d === liveDay) b.classList.add('now');
    if (mode === 'snap:' + d) b.classList.add('on');
    b.onclick = () => (has ? showSnapshot(d) : goLive());
    el.appendChild(b);
  }
  if (snapInfo.final) {
    const f = document.createElement('button'); f.className = 'live' + (mode === 'snap:final' ? ' on' : '');
    f.textContent = 'FINAL'; f.onclick = () => showSnapshot('final'); el.appendChild(f);
  }
  const l = document.createElement('button'); l.className = 'live' + (mode === 'live' ? ' on' : '');
  l.textContent = 'LIVE'; l.onclick = goLive; el.appendChild(l);
}

// ------------------------------------------------------------------- export
function exportPNG(scale = 4) {
  const size = renderer.getSize(new THREE.Vector2()), pr = renderer.getPixelRatio();
  const gl = renderer.getContext(), max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  scale = Math.min(scale, max / (size.x * pr), max / (size.y * pr));
  renderer.setPixelRatio(pr * scale); resize();
  U.uGain.value = Math.sqrt(scale);
  renderer.render(scene, camera);
  canvas.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `accumulation-of-presence-day${state ? state.day : ''}-${Date.now()}.png`;
    a.click();
    renderer.setPixelRatio(pr); resize(); U.uGain.value = 1;
  }, 'image/png');
}

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'h') $('hud').classList.toggle('hidden');
  if (k === 'f') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  if (k === 'p') exportPNG(e.shiftKey ? 8 : 4);
  if (k === 'l') goLive();
});

// --------------------------------------------------------------------- loop
let last = performance.now() / 1000, motionT = 0;
const cur = { drift: 0, volume: 0, wave: 0, complexity: 0, emergence: 0, freeze: 0 };
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, dt = Math.min(0.1, now - last); last = now;
  for (const k in cur) cur[k] += ((target[k] || 0) - cur[k]) * Math.min(1, dt * 0.5);
  const motion = 1 - cur.freeze;            // the last day slows to stillness
  motionT += dt * motion;
  U.uT.value = motionT; U.uClock.value += dt * Math.max(0.02, motion);
  U.uDrift.value = cur.drift; U.uVolume.value = cur.volume; U.uWave.value = cur.wave;
  U.uComplex.value = cur.complexity; U.uEmerge.value = cur.emergence;
  MAT.threads.uniforms.uAmp.value = (0.004 + 0.045 * cur.drift) * motion;
  MAT.veins.uniforms.uAmp.value = (0.008 + 0.02 * cur.volume) * motion;
  MAT.tissue.uniforms.uAmp.value = (0.015 + 0.03 * cur.complexity) * motion;
  MAT.nodes.uniforms.uAmp.value = MAT.veins.uniforms.uAmp.value;
  MAT.haze.uniforms.uAmp.value = (0.02 + 0.03 * cur.volume) * motion;
  for (let i = 0; i < 8; i++) {
    const p = pulses[i];
    U.uPulses.value[i].set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0, p ? p[3] * motion : 0);
  }
  updateLive(dt, motion);
  maybeBuildStructures(now);
  renderer.render(scene, camera);
}

scene.add(links); scene.add(aura);
links.renderOrder = 2; aura.renderOrder = 3;
timeline();
connectWS();
poll();
loadSnapshots();
setInterval(poll, 3000);
setInterval(loadSnapshots, 60000);
requestAnimationFrame(frame);
window.presence = { exportPNG, showSnapshot, goLive };
