// Accumulation of Presence — renderer shared by the exhibition TV and the website.
// The server sends only a compact world state. From it, every screen grows the
// same luminous tree: visitors' paths become rivers of light, the rivers feed a
// trunk made of their fibres, and over seven days the tree branches, blossoms
// and finally sheds falling light. Everything is seeded and deterministic.
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';

const API = (window.PRESENCE_API || '/api').replace(/\/$/, '');
const W = 1.78;              // world half-width sent by the server (y is -1..1)
const TREE_SEED = 20261;     // one tree for every screen
const qs = new URLSearchParams(location.search);
const TV = qs.has('tv');
if (TV) document.body.classList.add('tv');
if (qs.has('clean')) document.body.classList.add('clean');
if (TV) document.body.style.cursor = 'none';

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
const BASE_PR = Math.min(window.devicePixelRatio || 1, TV ? 1.5 : 2);
renderer.setPixelRatio(BASE_PR);
renderer.setClearColor(0x020206, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.22);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const U = {
  uT: { value: 0 }, uClock: { value: 0 }, uPx: { value: 1 }, uGain: { value: 1 }, uS: { value: 1 },
  uGrow: { value: 0.05 }, uBloom: { value: 0 }, uFallAmt: { value: 0 }, uHalfH: { value: 1 },
  uBodies: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uBodyG: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uPulses: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uLit: { value: new Array(32).fill(-1) }, uLitAmt: { value: 0 },
};

const view = { halfW: 1, halfH: 1, S: 1, baseX: 0, baseY: 0, riverY0: 0, riverY1: 0 };
function resize() {
  const w = window.innerWidth, h = window.innerHeight, a = w / h;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  view.halfH = 1; view.halfW = a;
  camera.left = -view.halfW; camera.right = view.halfW; camera.top = 1; camera.bottom = -1;
  camera.updateProjectionMatrix();
  view.S = Math.min(view.halfW * 1.25, 1.0);
  view.riverY0 = -0.98; view.riverY1 = -0.98 + 0.5;
  view.baseX = 0; view.baseY = -0.62;
  U.uS.value = view.S; U.uHalfH.value = view.halfH;
  U.uPx.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / 1000;
  geometryDirty = true;
}
let geometryDirty = true;
window.addEventListener('resize', resize);

// world (camera / server) -> view
const toView = (x, y) => [x / W * view.halfW * 0.98, y * 0.85];

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

const COMMON = /* glsl */`
uniform float uT, uClock, uPx, uGain, uS, uGrow, uBloom, uFallAmt, uHalfH;
uniform vec4 uBodies[8]; uniform vec4 uBodyG[8]; uniform vec4 uPulses[8];
uniform float uLit[32]; uniform float uLitAmt;
${NOISE}
// a returning visitor: the parts that came from them light up
float lit(float owner){
  if (owner < 0.5 || uLitAmt <= 0.0) return 0.0;
  for (int i = 0; i < 32; i++) if (abs(uLit[i] - owner) < 0.5) return uLitAmt;
  return 0.0;
}
// a broken piece: falls from where it grew to the floor, and stays there
vec2 debris(vec2 p, vec4 d, float seed, out float fallen){
  float prog = clamp((uClock - d.z) / 2.4, 0.0, 1.0);
  float e = prog * prog;
  fallen = prog;
  vec2 q = mix(p, d.xy, e);
  q.x += sin(prog * 3.14159) * (fract(seed * 7.0) - 0.5) * 0.1 * uS;
  q.y += sin(prog * 3.14159) * 0.03 * uS;
  return q;
}
// living people bend the light around them; h = how free this point is to move (0 root .. 1 tip)
vec2 field(vec2 p, float h, float seed, out float glow){
  glow = 0.0; vec2 q = p; float calm = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 b = uBodies[i];
    if (b.z < 0.5) continue;
    vec4 g = uBodyG[i];
    vec2 d = p - b.xy; float r = length(d) + 1e-4; vec2 n = d / r;
    float f = exp(-r * r / (0.12 * uS * uS)) * b.w;
    q += n * 0.03 * uS * f * h;
    q.y += 0.18 * uS * f * g.x * h;                       // hands up: everything is drawn upward
    q += n * 0.16 * uS * f * g.y * h;                     // arms open: the light steps back
    float ring = r - fract(uClock * 0.7 + float(i) * 0.37) * 1.4 * uS;
    q += n * 0.04 * uS * exp(-ring * ring / (0.003 * uS * uS)) * g.w * b.w * h;   // fast: a wave
    calm = max(calm, exp(-r * r / (0.25 * uS * uS)) * g.z * b.w);               // stillness: calm
    glow += f * 0.45;
  }
  for (int i = 0; i < 8; i++) {
    vec4 P = uPulses[i];
    float age = uClock - P.z;
    if (P.w <= 0.0 || age < 0.0 || age > 12.0) continue;
    vec2 d = p - P.xy; float r = length(d) + 1e-4;
    float ring = r - age * 0.3 * uS;
    float w = exp(-ring * ring / (0.002 * uS * uS)) * exp(-age * 0.35) * P.w;
    q += d / r * 0.02 * uS * w * h;
    glow += w * 0.7;
  }
  float a = (1.0 - calm * 0.85) * h * h;
  q.x += (sin(uT * 0.55 + p.y * 2.3 / uS + seed) * 0.010 + snoise(p * 1.6 / uS + vec2(uT * 0.05, seed)) * 0.012) * uS * a;
  q.y += snoise(p * 1.6 / uS + vec2(seed + 4.0, uT * 0.05)) * 0.007 * uS * a;
  return q;
}`;

// fibres: trunk, branches, roots (kind 0) and rivers (kind 1)
const FIBRE_VS = /* glsl */`
${COMMON}
uniform float uKind;
attribute vec4 aInfo;    // seed, t along, s = distance from the root (0..1), alpha
attribute vec3 aCol;
attribute float aOwner;  // which visitor this fibre came from
attribute vec4 aDebris;  // floor x, floor y, time it broke, 1 = broken piece / 2 = new growth
varying vec3 vCol; varying float vA, vGlow, vS, vSeed, vT, vHl, vDeb;
void main(){
  float glow = 0.0, fallen = 0.0;
  vec2 p = position.xy;
  float appear = 1.0;
  if (aDebris.w > 0.5 && aDebris.w < 1.5) {
    p = debris(p, aDebris, aInfo.x, fallen);
  } else {
    float h = uKind < 0.5 ? aInfo.z : 0.35;
    if (aDebris.w > 1.5) { h = 0.0; appear = clamp((uClock - aDebris.z - 1.8) / 4.0, 0.0, 1.0); }
    if (uKind > 0.5) p.y += snoise(vec2(p.x * 1.8 / uS + uT * 0.12, aInfo.x * 9.0)) * 0.012 * uS;
    p = field(p, h, aInfo.x * 13.0, glow);
  }
  vHl = lit(aOwner); vDeb = fallen;
  vCol = aCol; vGlow = glow; vS = aInfo.z; vSeed = aInfo.x; vT = aInfo.y; vA = aInfo.w * appear;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;
const FIBRE_FS = /* glsl */`
uniform float uGrow, uAlpha, uClock, uGain, uKind; uniform vec4 uPulses[8];
varying vec3 vCol; varying float vA, vGlow, vS, vSeed, vT, vHl, vDeb;
void main(){
  float reveal = uKind < 0.5 ? smoothstep(uGrow, uGrow - 0.025, vS) : 1.0;
  if (reveal <= 0.0) discard;
  float speed = uKind < 0.5 ? 0.9 : 1.8;
  float flow = pow(0.5 + 0.5 * sin(vS * 70.0 + vT * 6.0 - uClock * speed * 3.0 + vSeed * 40.0), 10.0);
  float up = 0.0;   // a new visitor's energy climbs from the roots to the crown
  if (uKind < 0.5) for (int i = 0; i < 8; i++) {
    vec4 P = uPulses[i]; float age = uClock - P.z;
    if (P.w <= 0.0 || age < 0.0 || age > 10.0) continue;
    float d = vS - age * 0.2;
    up += exp(-d * d / 0.002) * P.w * exp(-age * 0.12);
  }
  float a = uAlpha * uGain * vA * reveal * (0.45 + 1.1 * flow + vGlow * 0.8 + min(up, 1.0) * 1.2) * (1.0 + vHl * 6.0);
  vec3 col = mix(vCol, vec3(1.0, 0.86, 0.5), vHl * 0.8) * (1.0 + up * 1.2 + flow * 0.8);
  // fallen pieces: ash and dying embers on the floor
  float ember = 0.55 + 0.45 * sin(uClock * (0.6 + fract(vSeed * 9.0)) + vSeed * 40.0);
  col = mix(col, vec3(1.0, 0.36, 0.18) * (0.45 + 0.75 * ember), vDeb * 0.85);
  a *= 1.0 + vDeb * (1.2 + 0.8 * ember);
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

// blossoms & sparkles
const BLOSSOM_VS = /* glsl */`
${COMMON}
attribute vec4 aInfo;    // seed, size, s (when the branch reaches it), kind (0 flower, 1 spark)
attribute vec3 aCol;
attribute float aOwner;
attribute vec4 aDebris;
varying vec3 vCol; varying float vB, vSeed, vRot, vKind, vGlow, vHl, vDeb;
void main(){
  float glow = 0.0, fallen = 0.0;
  vec2 p;
  if (aDebris.w > 0.5) p = debris(position.xy, aDebris, aInfo.x, fallen);
  else p = field(position.xy, 0.9, aInfo.x * 11.0, glow);
  float b = clamp((uGrow - aInfo.z) / 0.06, 0.0, 1.0) * uBloom;
  float breath = 0.85 + 0.15 * sin(uClock * 1.7 + aInfo.x * 30.0);
  vHl = lit(aOwner); vDeb = fallen;
  vB = b; vSeed = aInfo.x; vKind = aInfo.w; vCol = aCol; vGlow = glow;
  vRot = aInfo.x * 6.283 + uT * 0.25 * (fract(aInfo.x * 7.0) - 0.5) + fallen * 2.0;
  gl_PointSize = aInfo.y * uPx * b * breath * (1.0 + glow * 0.5) * (1.0 + vHl * 1.6) * (1.0 - fallen * 0.3);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;
const FLOWER_FS = /* glsl */`
uniform float uAlpha, uGain, uClock;
varying vec3 vCol; varying float vB, vSeed, vRot, vKind, vGlow, vHl, vDeb;
void main(){
  vec2 c = (gl_PointCoord - 0.5) * 2.0; float r = length(c);
  if (r > 1.0 || vB <= 0.0) discard;
  float ang = atan(c.y, c.x) + vRot;
  float petal = 0.5 + 0.5 * abs(cos(2.5 * ang));
  float shape = vKind < 0.5 ? smoothstep(petal * 0.95, petal * 0.55, r) : exp(-r * r * 10.0);
  float core = exp(-r * r * 40.0);
  float halo = exp(-r * r * 3.5) * 0.1;
  float tw = 0.65 + 0.35 * sin(uClock * (2.0 + fract(vSeed * 13.0) * 3.0) + vSeed * 50.0);
  float a = (shape * 0.75 + core * 1.3 + halo) * tw * (1.0 + vGlow * 0.6) * (1.0 + vHl * 3.0) * mix(1.0, 0.7, vDeb);
  vec3 col = mix(vCol, vec3(1.0, 0.97, 0.9), core * 0.8);
  col = mix(col, vec3(1.0, 0.88, 0.55), vHl * 0.5);
  col = mix(col, vec3(1.0, 0.4, 0.22), vDeb * 0.7);
  gl_FragColor = vec4(col, min(a * uAlpha * uGain, 1.0));
}`;

// falling petals of light (uDir -1) and sparks rising from the rivers (uDir +1)
const FALL_VS = /* glsl */`
${COMMON}
uniform float uDir, uDist;
attribute vec4 aInfo;    // seed, size, speed, kind
attribute vec3 aCol;
varying vec3 vCol; varying float vB, vSeed, vRot, vKind, vGlow, vHl, vDeb;
void main(){
  vHl = 0.0; vDeb = 0.0;
  float prog = fract(uT * aInfo.z + aInfo.x * 13.7);
  vec2 p = position.xy;
  p.y += uDir * prog * uDist * uS;
  p.x += (sin(prog * 6.0 + aInfo.x * 20.0) * 0.05 + prog * 0.08 * (fract(aInfo.x * 3.1) - 0.3)) * uS;
  float glow;
  p = field(p, 0.6, aInfo.x * 7.0, glow);
  float kind = mod(aInfo.w, 2.0), from = floor(aInfo.w / 2.0) / 1000.0;
  float amt = uDir < 0.0 ? uFallAmt * step(from, uGrow - 0.02) : 0.35 + 0.65 * uBloom;
  vB = sin(prog * 3.14159) * amt * step(-uHalfH, p.y);
  vSeed = aInfo.x; vKind = kind; vCol = aCol; vGlow = glow;
  vRot = prog * 9.0 * (fract(aInfo.x * 3.0) - 0.5) + aInfo.x * 6.0;
  gl_PointSize = aInfo.y * uPx * (0.65 + 0.35 * abs(sin(prog * 18.0 + aInfo.x * 9.0))) * step(0.001, vB);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

// night sky: deep gradient, faint nebula, stars, warm glow at the foot of the tree
const SKY_FS = /* glsl */`
uniform float uClock, uAspect, uBloom; uniform vec2 uBase;
varying vec2 vUv;
${NOISE}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 p = vec2((vUv.x - 0.5) * 2.0 * uAspect, vUv.y * 2.0 - 1.0);
  vec3 col = mix(vec3(0.012, 0.010, 0.030), vec3(0.004, 0.004, 0.012), vUv.y);
  float n = snoise(p * 0.9 + vec2(uClock * 0.004, 0.0)) * 0.5 + snoise(p * 2.3 - vec2(0.0, uClock * 0.006)) * 0.25;
  col += vec3(0.05, 0.02, 0.09) * smoothstep(0.1, 0.9, n) * (0.4 + 0.6 * uBloom);
  col += vec3(0.01, 0.03, 0.06) * smoothstep(0.3, 1.0, -n);
  vec2 g = floor(p * 90.0); float h = hash(g);
  vec2 f = fract(p * 90.0) - 0.5 - (vec2(hash(g + 3.1), hash(g + 7.7)) - 0.5) * 0.6;
  float star = exp(-dot(f, f) * 60.0) * step(0.994, h);
  col += vec3(0.8, 0.85, 1.0) * star * (0.35 + 0.3 * sin(uClock * (1.0 + h * 5.0) + h * 90.0)) * smoothstep(-0.3, 0.5, p.y);
  float d = length((p - uBase) * vec2(0.6, 2.2));
  col += vec3(1.0, 0.62, 0.3) * exp(-d * d * 3.0) * 0.06 * (0.4 + uBloom);
  gl_FragColor = vec4(col, 1.0);
}`;

const blend = { transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending };
const fibreMat = (kind, alpha) => new THREE.ShaderMaterial({ vertexShader: FIBRE_VS, fragmentShader: FIBRE_FS,
  uniforms: { ...U, uKind: { value: kind }, uAlpha: { value: alpha } }, ...blend });
const MAT = {
  tree: fibreMat(0, 0.2),
  river: fibreMat(1, 0.06),
  mem: fibreMat(1, 0.0),
  blossom: new THREE.ShaderMaterial({ vertexShader: BLOSSOM_VS, fragmentShader: FLOWER_FS,
    uniforms: { ...U, uAlpha: { value: 0.32 } }, ...blend }),
  fall: new THREE.ShaderMaterial({ vertexShader: FALL_VS, fragmentShader: FLOWER_FS,
    uniforms: { ...U, uAlpha: { value: 0.45 }, uDir: { value: -1 }, uDist: { value: 1.7 } }, ...blend }),
  rise: new THREE.ShaderMaterial({ vertexShader: FALL_VS, fragmentShader: FLOWER_FS,
    uniforms: { ...U, uAlpha: { value: 0.35 }, uDir: { value: 1 }, uDist: { value: 0.5 } }, ...blend }),
};
const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: SKY_FS, depthTest: false, depthWrite: false,
  uniforms: { uClock: U.uClock, uBloom: U.uBloom, uAspect: { value: 1 }, uBase: { value: new THREE.Vector2() } },
}));
sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

// ------------------------------------------------------------------ palette
const PAL = {
  gold: [1.0, 0.78, 0.45], white: [1.0, 0.93, 0.82], pink: [1.0, 0.45, 0.82], violet: [0.66, 0.48, 1.0],
  cyan: [0.42, 0.8, 1.0], blue: [0.35, 0.5, 1.0],
};
function pick(rnd, weights) {
  let r = rnd() * weights.reduce((s, w) => s + w[1], 0);
  for (const [k, w] of weights) { if ((r -= w) <= 0) return PAL[k]; }
  return PAL[weights[0][0]];
}
const TRUNK_COLS = [['white', 1.5], ['gold', 3], ['violet', 2], ['cyan', 1.5], ['pink', 0.8]];
const TIP_COLS = [['pink', 3.5], ['violet', 2.5], ['gold', 1.5], ['cyan', 1.2], ['white', 0.3]];
const FLOWER_COLS = [['pink', 3], ['gold', 3], ['violet', 2], ['cyan', 1.5], ['white', 0.6]];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

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

const NODEB = [0, 0, -1e4, 0];
class Buf {
  constructor(points) { this.points = points; this.pos = []; this.info = []; this.col = []; this.own = []; this.deb = []; }
  v(x, y, i0, i1, i2, i3, c, owner = 0, deb = NODEB) {
    this.pos.push(x, y, 0); this.info.push(i0, i1, i2, i3); this.col.push(c[0], c[1], c[2]);
    this.own.push(owner); this.deb.push(deb[0], deb[1], deb[2], deb[3]);
  }
  object(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aOwner', new THREE.Float32BufferAttribute(this.own, 1));
    g.setAttribute('aDebris', new THREE.Float32BufferAttribute(this.deb, 4));
    const o = this.points ? new THREE.Points(g, mat) : new THREE.LineSegments(g, mat);
    o.frustumCulled = false;
    return o;
  }
}

// The skeleton of the tree: fixed seed, fitted to the screen.
function skeleton() {
  const rnd = mulberry32(TREE_SEED);
  const br = [], MAXD = 8;
  function grow(x, y, ang, len, w, depth, s0) {
    const bend = (rnd() - 0.5) * (depth === 0 ? 0.35 : 0.7);
    const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len;
    const mx = (x + x1) / 2 - Math.sin(ang) * len * bend * 0.5, my = (y + y1) / 2 + Math.cos(ang) * len * bend * 0.5;
    br.push({ x, y, mx, my, x1, y1, w, depth, s0, s1: s0 + len, len });
    if (depth >= MAXD) return;
    const n = depth === 0 ? 3 : (rnd() < 0.28 ? 3 : 2);
    for (let i = 0; i < n; i++) {
      const spread = (depth === 0 ? 0.8 : 0.42) + rnd() * 0.32;
      let a = ang + (i / (n - 1) - 0.5) * 2 * spread + (rnd() - 0.5) * 0.3;
      if (depth >= 3) a += (Math.PI / 2 - a) * -0.08;   // the crown spreads and droops
      else a += (Math.PI / 2 - a) * 0.12;
      grow(x1, y1, a, len * (0.74 + rnd() * 0.12) * (depth === 0 ? 1.1 : 1), w * 0.62, depth + 1, s0 + len);
    }
  }
  grow(0, 0, Math.PI / 2 + 0.05, 0.3, 0.11, 0, 0);
  // roots run down into the rivers
  const roots = [];
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? 1 : -1, a = -Math.PI / 2 + side * (0.5 + rnd() * 0.9);
    roots.push({ ang: a, len: 0.14 + rnd() * 0.16, w: 0.03 + rnd() * 0.02, bend: (rnd() - 0.5) * 0.8 });
  }
  // fit: the crown must stay inside the screen
  let minX = 0, maxX = 0, maxY = 0;
  for (const b of br) { minX = Math.min(minX, b.x1); maxX = Math.max(maxX, b.x1); maxY = Math.max(maxY, b.y1); }
  const maxS = Math.max(...br.map(b => b.s1));
  return { br, roots, minX, maxX, maxY, maxS };
}
const SK = skeleton();

// Damage: a shout, a strike or displeasure breaks a small piece of the crown.
// Each damage picks a branch near where the person stood; everything inside
// the wound falls to the floor and stays there, and a new, different order
// (sharp crystalline growth) slowly appears in the gap.
function damageZones(damages, X, Y, grow) {
  const zones = [];
  const nowServer = Date.now() / 1000 + serverOffset;
  for (const d of damages || []) {
    const [, x, , strength, seed, ts] = d;
    const rnd = mulberry32(seed);
    const tx = toView(x, 0)[0];
    const cand = SK.br
      .filter(b => b.depth >= 3 && b.s1 / SK.maxS < grow - 0.02)
      .map(b => ({ b, d: Math.abs(X((b.x + b.x1) / 2) - tx) }))
      .sort((a, b) => a.d - b.d).slice(0, 10);
    if (!cand.length) continue;
    const b = cand[Math.floor(rnd() * cand.length)].b, t = 0.3 + rnd() * 0.6;
    const u = 1 - t;
    const cx = X(u * u * b.x + 2 * u * t * b.mx + t * t * b.x1), cy = Y(u * u * b.y + 2 * u * t * b.my + t * t * b.y1);
    const age = mode === 'live' ? Math.max(0, nowServer - ts) : 1e4;
    zones.push({ cx, cy, R: (0.035 + 0.05 * strength) * view.S, t0: U.uClock.value - age, rnd, seed });
  }
  return zones;
}
const floorY = rnd => view.baseY + 0.03 - Math.pow(rnd(), 0.7) * (view.baseY - view.riverY0) * 0.75;

function buildTree(visitors, damages) {
  const rnd = mulberry32(TREE_SEED + 7);
  const sc = Math.min((view.halfW * 0.96) / Math.max(-SK.minX, SK.maxX), (1 - view.baseY - 0.06) / SK.maxY);
  const bx = view.baseX, by = view.baseY;
  const X = x => bx + x * sc, Y = y => by + y * sc;
  // narrow (portrait) screens pack the same tree tighter: thin the light accordingly
  const scRef = Math.min((W * 0.96) / Math.max(-SK.minX, SK.maxX), (1.56) / SK.maxY);
  const dens = Math.min(1, sc / scRef);
  MAT.tree.uniforms.uAlpha.value = 0.2 * (0.12 + 0.88 * dens * dens);
  MAT.blossom.uniforms.uAlpha.value = 0.32 * (0.3 + 0.7 * dens);
  const fibres = new Buf(false), blossoms = new Buf(true), fall = new Buf(true);
  const V = Math.max(1, visitors);
  const zones = damageZones(damages, X, Y, target.grow);
  const zoneOf = (x, y) => {
    for (let i = 0; i < zones.length; i++) if (Math.hypot(x - zones[i].cx, y - zones[i].cy) < zones[i].R) return i;
    return -1;
  };
  // the trunk is literally made of visitors: more people, more fibres of light
  const F = Math.round(Math.min(64, 10 + visitors * 0.04));
  const w0 = SK.br[0].w;
  const curve = (b, t) => {
    const u = 1 - t;
    return [u * u * b.x + 2 * u * t * b.mx + t * t * b.x1, u * u * b.y + 2 * u * t * b.my + t * t * b.y1];
  };
  let strand = 0;
  for (const b of SK.br) {
    const n = Math.max(1, Math.round(F * Math.pow(b.w / w0, 0.85)));
    const segs = b.depth < 2 ? 14 : b.depth < 5 ? 8 : 5;
    const twist = 3 + rnd() * 4, nx = -(b.y1 - b.y) / b.len, ny = (b.x1 - b.x) / b.len;
    for (let i = 0; i < n; i++) {
      const o = n > 1 ? (i / (n - 1) - 0.5) : 0, ph = rnd() * 6.283, seed = rnd();
      const c = mix3(pick(rnd, TRUNK_COLS), pick(rnd, TIP_COLS), smooth(1, 6, b.depth));
      const alpha = Math.min(1, 2.6 / Math.pow(n, 0.62)) * (0.6 + 0.4 * rnd());
      const owner = 1 + (strand++ * 7919) % V;
      const pts = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const [cx, cy] = curve(b, t);
        const off = o * b.w * (1 - 0.35 * t) * (0.6 + 0.4 * Math.cos(t * twist + ph));
        const x = X(cx + nx * off), y = Y(cy + ny * off);
        pts.push([x, y, (b.s0 + b.len * t) / SK.maxS, t, zones.length ? zoneOf(x, y) : -1]);
      }
      let piece = [];
      const flush = () => {
        if (!piece.length) return;
        const z = zones[piece[0][4]], pr = z.rnd;
        let mx = 0, my = 0;
        for (const p of piece) { mx += p[0]; my += p[1]; }
        mx /= piece.length; my /= piece.length;
        const th = (pr() - 0.5) * Math.PI, cs = Math.cos(th), sn = Math.sin(th);
        const fx = Math.max(-view.halfW * 0.95, Math.min(view.halfW * 0.95, z.cx + (pr() - 0.5) * z.R * 5));
        const fy = floorY(pr), t0 = z.t0 + pr() * 0.9;
        for (let k = 1; k < piece.length; k++) {
          for (const p of [piece[k - 1], piece[k]]) {
            const dx = p[0] - mx, dy = p[1] - my;
            fibres.v(p[0], p[1], seed, p[3], p[2], alpha, c, owner, [fx + dx * cs - dy * sn, fy + (dx * sn + dy * cs) * 0.35, t0, 1]);
          }
        }
        piece = [];
      };
      for (let s = 1; s <= segs; s++) {
        const a = pts[s - 1], p = pts[s];
        if (a[4] < 0 && p[4] < 0) {
          flush();
          fibres.v(a[0], a[1], seed, a[3], a[2], alpha, c, owner);
          fibres.v(p[0], p[1], seed, p[3], p[2], alpha, c, owner);
        } else if (a[4] >= 0 && a[4] === p[4]) {
          if (!piece.length) piece.push(a);
          piece.push(p);
        } else {
          flush();   // the broken edge: a gap
        }
      }
      flush();
    }
  }
  // roots
  for (const r of SK.roots) {
    const n = Math.max(2, Math.round(F * r.w / w0 * 0.5));
    const ra = Math.min(1, 2.6 / Math.pow(n, 0.62)) * 0.6;
    for (let i = 0; i < n; i++) {
      const seed = rnd(), c = pick(rnd, TRUNK_COLS), spread = (rnd() - 0.5) * 0.4;
      let prev = null;
      for (let s = 0; s <= 10; s++) {
        const t = s / 10, a = r.ang + r.bend * t + spread * t;
        const d = r.len * t;
        const p = [X(Math.cos(a) * d * 1.3 + (rnd() - 0.5) * 0.004 + (i / n - 0.5) * r.w * (1 - t)), Y(Math.sin(a) * d * 0.7)];
        if (prev) { fibres.v(prev[0], prev[1], seed, t - 0.1, 0, ra, c); fibres.v(p[0], p[1], seed, t, 0, ra * (1 - t * 0.7), c); }
        prev = p;
      }
    }
  }
  // blossoms on the outer branches; their number grows with the visitors
  const outer = SK.br.filter(b => b.depth >= 5);
  const total = outer.reduce((s, b) => s + b.len * (b.depth - 4), 0);
  const NB = Math.min(2600, 120 + visitors * 0.8) * (0.45 + 0.55 * dens);
  const fallers = [];
  let j = 0;
  for (const b of outer) {
    const k = Math.round(NB * b.len * (b.depth - 4) / total);
    for (let i = 0; i < k; i++) {
      const t = 0.25 + 0.75 * Math.pow(rnd(), 0.6);
      const [cx, cy] = curve(b, t);
      const r = (0.006 + 0.035 * rnd() * rnd()) * (b.depth >= 7 ? 1.3 : 1);
      const a = rnd() * 6.283;
      const x = X(cx + Math.cos(a) * r), y = Y(cy + Math.sin(a) * r * 0.8);
      const sN = (b.s0 + b.len * t) / SK.maxS;
      const flower = rnd() < 0.62;
      const size = (flower ? 7 + 15 * Math.pow(rnd(), 2) : 2 + 5 * rnd()) * (0.55 + 0.45 * dens);
      const c = pick(rnd, FLOWER_COLS), seed = rnd();
      const owner = 1 + (j++ * 104729) % V;
      const z = zones.length ? zoneOf(x, y) : -1;
      if (z >= 0) {
        const zr = zones[z].rnd;
        blossoms.v(x, y, seed, size, sN, flower ? 0 : 1, c, owner,
          [x + (zr() - 0.5) * zones[z].R * 4, floorY(zr), zones[z].t0 + zr() * 1.5, 1]);
        continue;
      }
      blossoms.v(x, y, seed, size, sN, flower ? 0 : 1, c, owner);
      if (flower && rnd() < 0.25) fallers.push([x, y, c, sN]);
    }
  }
  // the wound: embers on its edge and a new, different order growing in it
  for (const z of zones) {
    const zr = mulberry32(z.seed + 1);
    for (let i = 0; i < 14; i++) {
      const a = zr() * 6.283, r = z.R * (0.85 + zr() * 0.3);
      blossoms.v(z.cx + Math.cos(a) * r, z.cy + Math.sin(a) * r, zr(), 4 + 6 * zr(), 0, 1,
        zr() < 0.6 ? [1.0, 0.35, 0.18] : [1.0, 0.6, 0.25], 0, [0, 0, z.t0, 2]);
    }
    const n = 5 + Math.floor(zr() * 5);
    const cols = [[0.7, 0.95, 1.0], [1.0, 0.3, 0.42], [0.85, 0.85, 1.0]];
    for (let i = 0; i < n; i++) {
      let a = zr() * 6.283, x = z.cx + (zr() - 0.5) * z.R * 0.3, y = z.cy + (zr() - 0.5) * z.R * 0.3;
      const c = cols[Math.floor(zr() * 3)], seed = zr();
      for (let k = 0; k < 3; k++) {             // sharp, angular segments: another kind of order
        const len = z.R * (0.35 + zr() * 0.45);
        const nx = x + Math.cos(a) * len, ny = y + Math.sin(a) * len;
        for (const o of [-0.004, 0, 0.004]) {   // a few parallel lines: sharp and solid
          fibres.v(x + o, y - o, seed, k / 3, 0, 2.5, c, 0, [0, 0, z.t0, 2]);
          fibres.v(nx + o, ny - o, seed, (k + 1) / 3, 0, 2.5, c, 0, [0, 0, z.t0, 2]);
        }
        if (zr() < 0.5) {
          const b2 = a + (zr() < 0.5 ? 1 : -1) * 1.05, l2 = len * 0.5;
          fibres.v(nx, ny, seed, 0, 0, 2, c, 0, [0, 0, z.t0, 2]);
          fibres.v(nx + Math.cos(b2) * l2, ny + Math.sin(b2) * l2, seed, 1, 0, 2, c, 0, [0, 0, z.t0, 2]);
        }
        x = nx; y = ny; a += (zr() < 0.5 ? 1 : -1) * (0.9 + zr() * 0.5);
      }
    }
  }
  // petals that will fall
  const NF = Math.min(700, 40 + visitors * 0.2);
  for (let i = 0; i < NF && fallers.length; i++) {
    const [x, y, c, sN] = fallers[Math.floor(rnd() * fallers.length)];
    // w packs the kind (flower/spark) and the branch position it falls from
    fall.v(x, y, rnd(), 5 + 9 * rnd(), 0.025 + 0.05 * rnd(), Math.floor(sN * 1000) * 2 + (rnd() < 0.7 ? 0 : 1), c);
  }
  // sparks rising from the rivers
  const rise = new Buf(true);
  for (let i = 0; i < 260; i++) {
    const x = (rnd() * 2 - 1) * view.halfW, y = view.riverY0 + rnd() * (view.riverY1 - view.riverY0);
    rise.v(x, y, rnd(), 2 + 4 * rnd(), 0.02 + 0.04 * rnd(), 1.0, pick(rnd, [['gold', 3], ['cyan', 2], ['pink', 1]]));
  }
  sky.material.uniforms.uBase.value.set(X(0), Y(0));
  return [fibres.object(MAT.tree), blossoms.object(MAT.blossom), fall.object(MAT.fall), rise.object(MAT.rise)];
}

// visitors' paths become the rivers of light at the foot of the tree
const bornAt = new Map();
let firstLoad = true;
function catmull(p, i, t) {
  const n = p.length / 2, g = k => Math.min(n - 1, Math.max(0, k));
  const a = g(i - 1), b = g(i), c = g(i + 1), d = g(i + 2);
  const f = (k0, k1, k2, k3) => 0.5 * ((2 * k1) + (-k0 + k2) * t + (2 * k0 - 5 * k1 + 4 * k2 - k3) * t * t + (-k0 + 3 * k1 - 3 * k2 + k3) * t * t * t);
  return [f(p[a * 2], p[b * 2], p[c * 2], p[d * 2]), f(p[a * 2 + 1], p[b * 2 + 1], p[c * 2 + 1], p[d * 2 + 1])];
}
function buildRivers(threads, mat = MAT.river) {
  const buf = new Buf(false), n = threads.length;
  const y0 = view.riverY0, y1 = view.riverY1;
  const mapX = x => x / W * view.halfW * 1.02;
  const mapY = y => y0 + (y1 - y0) * Math.pow((y + 1) / 2, 1.3);
  threads.forEach((t, idx) => {
    const age = n > 1 ? 1 - idx / (n - 1) : 0;
    const rnd = mulberry32(t.s + 1), p = t.p, m = p.length / 2;
    const c = pick(rnd, [['cyan', 3], ['gold', 3], ['violet', 2], ['pink', 1.5], ['white', 1]]);
    if (t.i && !bornAt.has(t.i)) bornAt.set(t.i, firstLoad ? -1e4 : U.uClock.value);
    const fresh = t.i && U.uClock.value - bornAt.get(t.i) < 20 ? 2.0 : 1;
    const seed = rnd(), sub = 4, total = (m - 1) * sub;
    let prev = [mapX(p[0]), mapY(p[1])], k = 0;
    for (let i = 0; i < m - 1; i++) {
      for (let s = 1; s <= sub; s++) {
        const q = catmull(p, i, s / sub); k++;
        const tt = k / total, taper = Math.min(1, tt * 5, (1 - tt) * 5 + 0.2);
        const a = (1 - age * 0.6) * taper * fresh;
        const cur = [mapX(q[0]), mapY(q[1])];
        buf.v(prev[0], prev[1], seed, (k - 1) / total, (k - 1) / total, a, c, t.i);
        buf.v(cur[0], cur[1], seed, tt, tt, a, c, t.i);
        prev = cur;
      }
    }
  });
  return buf.object(mat);
}

// ---------------------------------------------------------------- live layer
// a person in front of the screen: a swirl of blossoming sparks, never a figure
const LIVE_MAX = 8, AURA = 120;
const auraGeo = new THREE.BufferGeometry();
const auraPos = new Float32Array(LIVE_MAX * AURA * 3), auraInfo = new Float32Array(LIVE_MAX * AURA * 4), auraCol = new Float32Array(LIVE_MAX * AURA * 3);
const auraSeeds = Array.from({ length: LIVE_MAX * AURA }, (_, i) => { const r = mulberry32(i + 11); return [r() * 6.283, r(), 0.3 + r(), r(), pick(r, FLOWER_COLS)]; });
auraSeeds.forEach((s, k) => { auraCol.set(s[4], k * 3); auraInfo.set([s[3], 0, 0, s[1] < 0.5 ? 0 : 1], k * 4); });
auraGeo.setAttribute('position', new THREE.BufferAttribute(auraPos, 3));
auraGeo.setAttribute('aInfo', new THREE.BufferAttribute(auraInfo, 4));
auraGeo.setAttribute('aCol', new THREE.BufferAttribute(auraCol, 3));
const auraMat = new THREE.ShaderMaterial({
  uniforms: { uPx: U.uPx, uClock: U.uClock, uAlpha: { value: 0.4 }, uGain: U.uGain },
  vertexShader: `uniform float uPx, uClock; attribute vec4 aInfo; attribute vec3 aCol;
    varying vec3 vCol; varying float vB, vSeed, vRot, vKind, vGlow, vHl, vDeb;
    void main(){ vHl = 0.0; vDeb = 0.0; vCol = aCol; vB = aInfo.z; vSeed = aInfo.x; vKind = aInfo.w; vGlow = 0.0; vRot = aInfo.x * 6.28 + uClock * 0.5;
      gl_PointSize = aInfo.y * uPx * step(0.001, aInfo.z); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: FLOWER_FS, ...blend,
});
const aura = new THREE.Points(auraGeo, auraMat); aura.frustumCulled = false;
const LINK_SEG = 7 * 24;
const linkGeo = new THREE.BufferGeometry();
const linkPos = new Float32Array(LIVE_MAX * LIVE_MAX * LINK_SEG * 2 * 3);
linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3));
const linkMat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthTest: false });
const links = new THREE.LineSegments(linkGeo, linkMat); links.frustumCulled = false;

const bodies = new Map();
let memKey = '';
function setLive(list) {
  const seen = new Set();
  for (const b of list || []) {
    seen.add(b.i);
    const cur = bodies.get(b.i) || { x: b.x, y: b.y, fade: 0, g: [0, 0, 0, 0] };
    cur.tx = b.x; cur.ty = b.y; cur.tg = [b.hu || 0, b.ao || 0, b.st || 0, b.fa || 0]; cur.alive = true;
    cur.pid = b.pid || 0; cur.lit = b.lit || null; cur.mem = b.mem || null;
    bodies.set(b.i, cur);
  }
  for (const [id, b] of bodies) if (!seen.has(id)) b.alive = false;
}

function updateLive(dt, motion) {
  for (const [id, b] of [...bodies.entries()]) {
    b.fade += ((b.alive ? 1 : 0) - b.fade) * Math.min(1, dt * (b.alive ? 2 : 0.8));
    const k = Math.min(1, dt * 6);
    b.x += (b.tx - b.x) * k; b.y += (b.ty - b.y) * k;
    for (let j = 0; j < 4; j++) b.g[j] += (b.tg[j] - b.g[j]) * Math.min(1, dt * 2.5);
    if (!b.alive && b.fade < 0.01) bodies.delete(id);
  }
  const list = [...bodies.values()].slice(0, LIVE_MAX).map(b => ({ ...b, v: toView(b.x, b.y) }));
  for (let i = 0; i < LIVE_MAX; i++) {
    const b = list[i];
    U.uBodies.value[i].set(b ? b.v[0] : 0, b ? b.v[1] : 0, b ? 1 : 0, b ? b.fade * motion : 0);
    U.uBodyG.value[i].set(...(b ? b.g : [0, 0, 0, 0]));
  }
  const T = U.uClock.value, S = view.S;
  // returning visitors: their own threads, fibres and blossoms light up,
  // and the paths they walked on earlier visits shine again in the river
  const lit = [], mems = [];
  let litAmt = 0;
  for (const b of bodies.values()) {
    if (!b.lit || !b.lit.length) continue;
    lit.push(...b.lit); mems.push(b); litAmt = Math.max(litAmt, b.fade);
  }
  for (let i = 0; i < 32; i++) U.uLit.value[i] = i < lit.length ? lit[i] : -1;
  U.uLitAmt.value = litAmt * motion * (0.75 + 0.25 * Math.sin(T * 2.2));
  MAT.mem.uniforms.uAlpha.value = 0.9 * litAmt * motion;
  const mk = mems.map(b => b.pid).join(',');
  if (mk !== memKey) {
    memKey = mk;
    const paths = [];
    mems.forEach(b => (b.mem || []).forEach((p, k) => paths.push({ i: 0, s: b.pid * 31 + k, p })));
    const o = paths.length ? buildRivers(paths, MAT.mem) : null;
    replace(layer.mem, o); layer.mem = o;
    if (o) o.renderOrder = 4;
  }
  for (let i = 0; i < LIVE_MAX; i++) {
    const b = list[i];
    for (let j = 0; j < AURA; j++) {
      const k = i * AURA + j, s = auraSeeds[k];
      if (!b) { auraInfo[k * 4 + 2] = 0; continue; }
      const spin = (b.g[2] > 0.5 ? 0.05 : 0.3 + b.g[3] * 1.4) * s[2];
      const a = s[0] + T * spin * (s[3] < 0.5 ? 1 : -1);
      const r = (0.03 + 0.2 * Math.pow(s[1], 0.7)) * S * (1 + b.g[1] * 0.9) * (1 + 0.15 * Math.sin(T * 0.8 + s[0] * 3));
      auraPos[k * 3] = b.v[0] + Math.cos(a) * r * 0.85;
      auraPos[k * 3 + 1] = b.v[1] + Math.sin(a) * r * 1.15 + b.g[0] * 0.22 * S * s[1];
      auraInfo[k * 4 + 1] = s[1] < 0.5 ? 5 + 9 * s[3] : 2 + 3 * s[3];
      auraInfo[k * 4 + 2] = b.fade * (0.3 + 0.7 * (1 - s[1])) * motion;
    }
  }
  auraGeo.attributes.position.needsUpdate = true; auraGeo.attributes.aInfo.needsUpdate = true;
  let v = 0;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [ax, ay] = list[i].v, [bx, by] = list[j].v, d = Math.hypot(ax - bx, ay - by);
    const str = smooth(1.2 * S, 0.4 * S, d) * Math.min(list[i].fade, list[j].fade);
    if (str < 0.02) continue;
    for (let s = 0; s < 7; s++) {
      const off = Math.sin(T * (0.4 + s * 0.13) + s * 2.1) * 0.2;
      const kx = (ax + bx) / 2 - (by - ay) * off, ky = (ay + by) / 2 + (bx - ax) * off;
      let px = ax, py = ay;
      for (let q = 1; q <= 24; q++) {
        const t = q / 24, u = 1 - t;
        const x = u * u * ax + 2 * u * t * kx + t * t * bx, y = u * u * ay + 2 * u * t * ky + t * t * by;
        linkPos.set([px, py, 0, x, y, 0], v * 3); v += 2; px = x; py = y;
      }
    }
  }
  linkGeo.setDrawRange(0, v);
  linkGeo.attributes.position.needsUpdate = true;
  linkMat.opacity = 0.08 * motion;
}

// ---------------------------------------------------------------- the world
const layer = { rivers: null, tree: [], mem: null };
let state = null, mode = 'live', threadKey = '', treeKey = '', lastTreeBuild = -10, lastDamageKey = '';
const target = { grow: 0.05, bloom: 0, fall: 0, freeze: 0, emerge: 0 };
const pulses = [];
const seenPulse = new Set();
let serverOffset = 0;

function replace(oldObjs, newObjs) {
  for (const o of [].concat(oldObjs || []).filter(Boolean)) { scene.remove(o); o.geometry.dispose(); }
  for (const o of [].concat(newObjs || []).filter(Boolean)) scene.add(o);
}

function growthOf(st) {
  const g = Math.min(1, 0.06 + 0.94 * (0.55 * (st.day - 1) / 6 + 0.45 * Math.pow(st.evolution, 0.8)));
  return { grow: g, bloom: smooth(0.32, 0.62, g), fall: smooth(0.45, 0.85, g) };
}

function applyState(st, isSnapshot = false) {
  const first = !state;
  state = st;
  if (st.now) serverOffset = st.now - Date.now() / 1000;
  Object.assign(target, growthOf(st), { freeze: isSnapshot ? 1 : st.params.freeze, emerge: st.params.emergence });
  if (first) Object.assign(cur, target);   // opening the page: the tree is already grown
  const tk = st.threads.length + ':' + (st.threads[0] || {}).i + ':' + (st.threads.at(-1) || {}).i + ':' + mode;
  if (tk !== threadKey || geometryDirty) { threadKey = tk; rebuildRivers(); }
  if (!isSnapshot) {
    for (const p of st.pulses || []) {
      const key = p[3] + ':' + p[0];
      if (seenPulse.has(key)) continue;
      seenPulse.add(key);
      const age = (Date.now() / 1000 + serverOffset) - p[3];
      const [x, y] = toView(p[0], -1 + (p[1] + 1) * 0.5);
      if (age < 12) pulses.push([x, Math.min(y, view.riverY1), U.uClock.value - age, p[2]]);
    }
    while (pulses.length > 8) pulses.shift();
    if (st.live && !ws) setLive(st.live);
  }
  firstLoad = false;
  hud();
}

function rebuildRivers() {
  if (!state) return;
  const r = buildRivers(state.threads);
  replace(layer.rivers, r); layer.rivers = r;
}

function maybeBuildTree(now) {
  if (!state) return;
  const v = state.stats.visitors;
  // rebuild when the number of people changes noticeably (or the screen changes)
  const dm = state.damages || [];
  const dkey = dm.length + ':' + (dm.length ? dm[dm.length - 1][0] : 0);
  const key = mode + ':' + (v < 200 ? v : Math.round(Math.log(v) * 40)) + ':' + dkey;
  const damaged = dkey !== lastDamageKey;    // a wound is shown at once
  if (!geometryDirty && !damaged && (key === treeKey || now - lastTreeBuild < 3)) return;
  lastDamageKey = dkey;
  if (geometryDirty) rebuildRivers();
  geometryDirty = false; treeKey = key; lastTreeBuild = now;
  const objs = buildTree(v, dm);
  objs[0].renderOrder = 1; objs[1].renderOrder = 2; objs[2].renderOrder = 3; objs[3].renderOrder = 3;
  replace(layer.tree, objs); layer.tree = objs;
}

// --------------------------------------------------------------------- data
const url = p => API + p;
let version = -1, ws = null;

async function poll() {
  if (mode !== 'live') return;
  try {
    const r = await fetch(url('/state?live=' + (ws ? 0 : 1) + '&since=' + version), { cache: 'no-store' });
    const st = await r.json();
    if (st.same || !st.threads) return;
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
  geometryDirty = false;
  composer.render();
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
const cur = { grow: 0.05, bloom: 0, fall: 0, freeze: 0, emerge: 0 };
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, dt = Math.min(0.1, now - last); last = now;
  for (const k in cur) cur[k] += ((target[k] || 0) - cur[k]) * Math.min(1, dt * (k === 'grow' ? 0.25 : 0.5));
  const motion = 1 - cur.freeze;            // the last day slows to stillness
  motionT += dt * motion;
  U.uT.value = motionT; U.uClock.value += dt * Math.max(0.02, motion);
  U.uGrow.value = cur.grow; U.uBloom.value = cur.bloom; U.uFallAmt.value = cur.fall;
  bloom.strength = 0.55 + 0.12 * cur.emerge + 0.08 * cur.bloom;
  sky.material.uniforms.uAspect.value = view.halfW;
  for (let i = 0; i < 8; i++) {
    const p = pulses[i];
    U.uPulses.value[i].set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0, p ? p[3] * motion : 0);
  }
  updateLive(dt, motion);
  maybeBuildTree(now);
  composer.render();
}

resize();
scene.add(links); scene.add(aura);
links.renderOrder = 4; aura.renderOrder = 5;
timeline();
connectWS();
poll();
loadSnapshots();
setInterval(poll, 3000);
setInterval(loadSnapshots, 60000);
requestAnimationFrame(frame);
window.presence = { exportPNG, showSnapshot, goLive };
