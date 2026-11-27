// sea.js — JONSWAP spectrum + Gerstner ocean, lifted from Hurricane Fleet
// (index.html L796-975, L1024-1300) and converted to METRIC scale:
// Hurricane ran 1 unit ≈ 5.74 m (GAME_M = 5.74, G_GAME = 9.81/5.74).
// This game is 1 unit = 1 m, so GAME_M = 1 and G_GAME = 9.81. All other
// constants (fetch 300 km, gamma 3.3, 14 wind-sea + 4 swell components,
// equal-variance quantiles, m0 fetch law) are verbatim.
import * as THREE from 'three';

// v1.6.0 Item 2: the seabed. SEA_FLOOR_Y = -90 m — the intact hull's keel
// (-30 m) at the old -55 m sink-curve end is -85 m, so a wreck comes to rest
// just below where it used to vanish: the sink curves need clamping, not
// retiming. Deep enough to read as sunk (a 55 m hull + island stays well
// under), shallow enough for the camera to reach underwater (murk FogExp2
// 0.005 keeps a wreck visible at ~200 m inspection range).
export const SEA_FLOOR_Y = -90;
export const STAGES = [
  { name: 'Calm',   speed: 20, amp: 0.35, wind: 5,  sky: 0x9fc3d8, sea: 0x1a5a78, sunI: 1.15 },
  { name: 'Rough',  speed: 25, amp: 0.70, wind: 10, sky: 0x7e9db4, sea: 0x174a64, sunI: 1.0 },
  { name: 'Storm',  speed: 30, amp: 1.05, wind: 15, sky: 0x5a7286, sea: 0x12394e, sunI: 0.85 },
  // v1.3.0 Hurricane (Hurricane Fleet's 4th stage): wind 20, bigger Hs,
  // heavier foam/rain feel. Only reached by the menu picker or by the
  // distance-driven progression — never the default.
  { name: 'Hurricane', speed: 35, amp: 1.4, wind: 20, sky: 0x46586a, sea: 0x0e2c40, sunI: 0.7 },
];
const G_GAME = 9.81;
const JONSWAP_FETCH = 300000, JONSWAP_GAMMA = 3.3, SPEC_N = 14;

function jonswapS(om, U) {
  const wp = 22 * Math.cbrt(9.81 * 9.81 / (U * JONSWAP_FETCH));
  const alpha = 0.076 * Math.pow(U * U / (JONSWAP_FETCH * 9.81), 0.22);
  const sig = om <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((om - wp) * (om - wp)) / (2 * sig * sig * wp * wp));
  return alpha * 9.81 * 9.81 / Math.pow(om, 5) * Math.exp(-1.25 * Math.pow(wp / om, 4)) * Math.pow(JONSWAP_GAMMA, r);
}

export class Sea {
  constructor(scene, stageIdx = 0) {
    this.stageIdx = stageIdx;
    this.WAVES = [];
    this.ampCur = STAGES[stageIdx].amp;
    this.ampTarget = this.ampCur;
    this.WAVE_AMP_SUM = 0;
    this.HS = 0;
    this.buildSpectrum(STAGES[stageIdx].wind);
    this.makeOcean(scene);
    // v1.3.0 freak wave (Hurricane v11.8-11.12, metric): one huge moving
    // Gaussian crest added to the Gerstner field. Hurricane amp 8u /
    // radius 22u / speed 22 u/s rescale to 8*5.74=46 m — far too tall for
    // a 1 m = 1 m sea whose Storm Hs is ~4 m — so the crest is re-derived
    // here: 14 m amp (still ~3x the Storm swell), 120 m radius, 30 m/s.
    // Carriers fly at >=150 m, so they are safe; low jets are not.
    this.freak = null; // {x,z,dirX,dirZ,amp,radius,speed,age,life}
    // v1.6.0 perf: per-frame wave table. gerstner()/getOceanDataAt()
    // are called ~1000x/frame (897 ocean verts + every carrier/jet/
    // wreck query) with the same time t and ampCur, so the per-wave
    // terms that depend only on (t, ampCur) are precomputed once per
    // distinct pair instead of per call: kdx = k*dx, kdz = k*dz,
    // wt = w*t, A = amp*ampCur, Q = min(q, 1/(k*A)). The per-call
    // math is identical, only reassociated (fp differences ~1e-9).
    this._wt = [];
    for (let i = 0; i < 18; i++) this._wt.push({ kdx: 0, kdz: 0, wt: 0, ph: 0, A: 0, Q: 0, dx: 0, dz: 0, k: 0, w: 0 });
    this._wtT = NaN; this._wtAmp = NaN;
    this._gTmp = { x: 0, y: 0, z: 0 };
  }
  // Gaussian crest height of the freak wave at (x,z), 0 when none/absent.
  freakHeightAt(x, z) {
    const fw = this.freak;
    if (!fw) return 0;
    const fdx = x - fw.x, fdz = z - fw.z;
    const fd2 = fdx * fdx + fdz * fdz, fr2 = fw.radius * fw.radius;
    if (fd2 >= fr2 * 9) return 0;
    return fw.amp * Math.exp(-fd2 / (2 * fr2));
  }
  buildSpectrum(U) {
    const wp = 22 * Math.cbrt(9.81 * 9.81 / (U * JONSWAP_FETCH));
    const lo = 0.3 * wp, hi = 4 * wp, M = 240, dw = (hi - lo) / M;
    const cdf = [0]; let m0int = 0;
    for (let s = 0; s < M; s++) {
      m0int += 0.5 * (jonswapS(lo + s * dw, U) + jonswapS(lo + (s + 1) * dw, U)) * dw;
      cdf.push(m0int);
    }
    const m0 = 1.67e-7 * U * U * JONSWAP_FETCH / 9.81;
    const aM = Math.sqrt(2 * m0 / SPEC_N);
    const frac = x => x - Math.floor(x);
    const comps = [];
    for (let i = 0; i < SPEC_N; i++) {
      const target = (i + 0.5) / SPEC_N * m0int;
      let s = 0; while (s < M && cdf[s + 1] < target) s++;
      const f = (target - cdf[s]) / Math.max(1e-12, cdf[s + 1] - cdf[s]);
      const om = lo + (s + f) * dw;
      const kM = om * om / 9.81, lamM = 2 * Math.PI / kM;
      const th = 0.7 * Math.sin(2 * Math.PI * i * 0.618034);
      comps.push({ lam: lamM, amp: aM, q: 0.7, dx: Math.sin(th), dz: Math.cos(th),
        ph: 2 * Math.PI * frac(Math.sin(i * 127.1 + 311.7) * 43758.5453),
        k: 2 * Math.PI / lamM, w: 0 });
    }
    const HsM = 4 * Math.sqrt(m0);
    const swellLams = [350, 280, 220, 160];
    for (let j = 0; j < 4; j++) {
      const th = 0.96 + 0.09 * Math.sin(2 * Math.PI * j * 0.618034);
      const lamM = swellLams[j];
      comps.push({ lam: lamM, amp: 0.1 * HsM, q: 0.4, dx: Math.sin(th), dz: Math.cos(th),
        ph: 2 * Math.PI * frac(Math.sin(j * 57.3 + 91.7) * 24634.6345),
        k: 2 * Math.PI / lamM, w: 0 });
    }
    comps.forEach(w => { w.w = Math.sqrt(G_GAME * w.k); });
    this.WAVES = comps;
    this.WAVE_AMP_SUM = comps.reduce((a, w) => a + w.amp, 0);
    this.HS = HsM;
  }
  _prepWaves(t) {
    if (t === this._wtT && this.ampCur === this._wtAmp) return;
    this._wtT = t; this._wtAmp = this.ampCur;
    const W = this.WAVES, T = this._wt;
    for (let i = 0; i < W.length; i++) {
      const w = W[i], e = T[i];
      const A = w.amp * this.ampCur;
      e.kdx = w.k * w.dx; e.kdz = w.k * w.dz; e.wt = w.w * t; e.ph = w.ph;
      e.A = A; e.Q = Math.min(w.q, 1 / Math.max(0.001, w.k * A));
      e.dx = w.dx; e.dz = w.dz; e.k = w.k; e.w = w.w;
    }
  }
  gerstner(x, z, t) {
    this._prepWaves(t);
    let y = 0, ox = 0, oz = 0, dydx = 0, dydz = 0;
    const T = this._wt, n = this.WAVES.length;
    for (let i = 0; i < n; i++) {
      const e = T[i];
      const th = e.kdx * x + e.kdz * z - e.wt + e.ph;
      const sn = Math.sin(th), cs = Math.cos(th);
      ox += e.Q * e.A * e.dx * cs;
      oz += e.Q * e.A * e.dz * cs;
      y += e.A * sn;
      // v1.6.0 perf: analytic slopes in the same pass (no extra trig)
      // — feeds the ocean normal + steepness in update() without
      // computeVertexNormals. The freak slope is not included here,
      // exactly as before (only getOceanDataAt carries it).
      dydx += e.A * e.kdx * cs;
      dydz += e.A * e.kdz * cs;
    }
    y += this.freakHeightAt(x, z);
    const g = this._gTmp; g.x = x + ox; g.y = y; g.z = z + oz; g.dydx = dydx; g.dydz = dydz;
    return g;
  }
  waveHeight(x, z, t) { return this.gerstner(x, z, t).y; }
  // The shared ocean query — verbatim structure from Hurricane L907-957.
  getOceanDataAt(x, z, t) {
    this._prepWaves(t);
    let y = 0, dydx = 0, dydz = 0, doxdx = 0, doxdz = 0, dozdx = 0, dozdz = 0, ovx = 0, ovy = 0, ovz = 0;
    const T = this._wt, n = this.WAVES.length;
    for (let i = 0; i < n; i++) {
      const e = T[i];
      const th = e.kdx * x + e.kdz * z - e.wt + e.ph;
      const A = e.A, Q = e.Q, kdx = e.kdx, kdz = e.kdz;
      const sn = Math.sin(th), cs = Math.cos(th);
      y += A * sn;
      dydx += A * kdx * cs; dydz += A * kdz * cs;
      doxdx += -Q * A * kdx * e.dx * sn; doxdz += -Q * A * kdx * e.dz * sn;
      dozdx += -Q * A * kdz * e.dx * sn; dozdz += -Q * A * kdz * e.dz * sn;
      ovx += Q * A * e.dx * e.w * sn; ovy += -A * e.w * cs; ovz += Q * A * e.dz * e.w * sn;
    }
    // v1.3.0 freak wave in the shared ocean query too (Hurricane v11.8):
    // height and slope, so wave push / swamping see the same crest.
    if (this.freak) {
      const fg = this.freakHeightAt(x, z);
      if (fg > 0) {
        const fw = this.freak, fr2 = fw.radius * fw.radius;
        y += fg;
        dydx += -fg * (x - fw.x) / fr2; dydz += -fg * (z - fw.z) / fr2;
      }
    }
    const tx = 1 + doxdx, ty = dydx, tz = dozdx;
    const ux = doxdz, uy = dydz, uz = 1 + dozdz;
    let nx = uy * tz - uz * ty, ny = uz * tx - ux * tz, nz = ux * ty - uy * tx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    return { height: y, nx: nx / nl, ny: ny / nl, nz: nz / nl, ovx, ovy, ovz, slopeX: dydx, slopeZ: dydz };
  }
  wavePush(x, z, t) {
    const d = this.getOceanDataAt(x, z, t);
    return { x: d.ovx - d.slopeX * G_GAME * 0.17, z: d.ovz - d.slopeZ * G_GAME * 0.17 };
  }
  tideAt(t) { return { x: Math.sin((t / 720) * Math.PI * 2) * 1.0, z: 0 }; }

  makeOcean(scene) {
    const RINGS = [12, 24, 48, 96, 144, 192, 288, 384, 512, 850, 1200, 1700, 2400, 3000];
    const SPOKES = 64;
    const pos = [0, 0, 0];
    for (const R of RINGS) for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
      pos.push(Math.cos(a) * R, 0, Math.sin(a) * R);
    }
    const idx = [];
    const rs = r => 1 + r * SPOKES;
    for (let i = 0; i < SPOKES; i++) { const j = (i + 1) % SPOKES; idx.push(0, rs(0) + j, rs(0) + i); }
    for (let r = 0; r < RINGS.length - 1; r++) for (let i = 0; i < SPOKES; i++) {
      const j = (i + 1) % SPOKES;
      const a = rs(r) + i, b = rs(r) + j, c = rs(r + 1) + i, d = rs(r + 1) + j;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.oceanGeo = g;
    this.oceanPos = g.attributes.position;
    this.oceanBase = this.oceanPos.array.slice();
    this.oceanSteep = new Float32Array(this.oceanPos.count);
    this.oceanH = new Float32Array(this.oceanPos.count);
    g.setAttribute('aSteep', new THREE.BufferAttribute(this.oceanSteep, 1));
    g.setAttribute('aH', new THREE.BufferAttribute(this.oceanH, 1));
    // v1.6.0 perf: the normal attribute is filled analytically in
    // update() (same field computeVertexNormals derived it from, see
    // below) — pre-allocate it here so the vertex shader always has
    // valid normals from frame 0.
    this.oceanNrm = new Float32Array(this.oceanPos.count * 3);
    g.setAttribute('normal', new THREE.BufferAttribute(this.oceanNrm, 3));
    const MAXS = 12; // uShips[12]: up to 8 carriers + 4 wreck slots (was 8 in Hurricane)
    const shipVecs = [], shipSizes = [];
    for (let i = 0; i < MAXS; i++) { shipVecs.push(new THREE.Vector4()); shipSizes.push(new THREE.Vector2()); }
    this.MAXS = MAXS;
    // v1.4.2 rotor downwash: uWash[32] — one source per live lift pod
    // (8 carriers x 4 pods). vec4(x, z, strength, radius). strength is
    // the physics strength (see the note in game.js): lift actually
    // produced per pod, faded with height; the shader turns it into a
    // flattened disc + spray ring + churn + radial streaks. Zero
    // strength = no source. Filled by Sea.update's `wash` argument.
    const WASH_MAX = 32;
    const washVecs = [];
    for (let i = 0; i < WASH_MAX; i++) washVecs.push(new THREE.Vector4());
    this.WASH_MAX = WASH_MAX;
    this.uniforms = {
      uDeep: { value: new THREE.Color(0x0d2839) },
      uBase: { value: new THREE.Color(0x1a5a78) },
      uCrest: { value: new THREE.Color(0x9fd4e8) },
      uSky: { value: new THREE.Color(0x9fc3d8) },
      uSunDir: { value: new THREE.Vector3(30, 35, -80).normalize() },
      uSunI: { value: 1.15 },
      uTime: { value: 0 },
      uFoam: { value: new THREE.Color(0xa9c2cf) },
      uShips: { value: shipVecs },
      uShipSize: { value: shipSizes },
      uWash: { value: washVecs },
      uWind: { value: new THREE.Vector2(0, 1) },
      uWindStr: { value: 0 },
    };
    Object.assign(this.uniforms, THREE.UniformsUtils.clone(THREE.UniformsLib.fog));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, fog: true, side: THREE.DoubleSide,
      vertexShader: `
        attribute float aSteep; attribute float aH;
        varying vec3 vNormal; varying vec3 vWorldPos; varying float vSteep; varying float vH;
        #include <fog_pars_vertex>
        void main(){
          vNormal = normalize(normalMatrix * normal);
          vSteep = aSteep; vH = aH;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform vec3 uDeep; uniform vec3 uBase; uniform vec3 uCrest; uniform vec3 uSky;
        uniform vec3 uSunDir; uniform float uSunI; uniform float uTime; uniform vec3 uFoam;
        uniform vec4 uShips[${MAXS}]; uniform vec2 uShipSize[${MAXS}];
        uniform vec4 uWash[${WASH_MAX}];
        uniform vec2 uWind; uniform float uWindStr;
        varying vec3 vNormal; varying vec3 vWorldPos; varying float vSteep; varying float vH;
        #include <fog_pars_fragment>
        float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        void main(){
          if(!gl_FrontFacing){
            vec3 R = normalize(vWorldPos - cameraPosition);
            float win = smoothstep(0.55, 0.70, R.y);
            vec3 skyRef = uSky * 1.8 + vec3(1.0, 0.95, 0.8) * pow(max(dot(R, uSunDir), 0.0), 200.0) * 3.0;
            vec3 abyss = vec3(0.01, 0.10, 0.16);
            gl_FragColor = vec4(mix(abyss, skyRef, win), 1.0);
            return;
          }
          vec3 V = normalize(cameraPosition - vWorldPos);
          float dist = length(cameraPosition - vWorldPos);
          vec2 wp = vWorldPos.xz;
          float detailFade = exp(-dist / 170.0);
          // v1.4.2 rotor downwash (physics: see game.js wash builder —
          // strength = lift actually produced per pod, faded with height
          // as the jet spreads; the jet presses the water flat under
          // each pod, throws a spray ring where it turns outward, and
          // churns the disc white with radial streaks). Flattening is
          // applied to the ripple normals below; the foam is mixed in
          // with the wave/wake foam at the end. Per-fragment cost is
          // one cheap bounds check per source; noise runs only inside
          // a disc. washFlat/washFoam are 0 where no source reaches.
          float washFoam = 0.0;
          float washFlat = 0.0;
          for(int i = 0; i < ${WASH_MAX}; i++){
            vec4 w = uWash[i];
            if(w.z > 0.003){
              vec2 d = wp - w.xy;
              float R = w.w;
              if(abs(d.x) < R && abs(d.y) < R){
                float r = length(d) / R;
                if(r < 1.0){
                  float ang = atan(d.y, d.x);
                  float ring = smoothstep(0.45, 0.62, r) * (1.0 - smoothstep(0.78, 1.0, r));
                  float churnN = vnoise(wp * 1.5 + vec2(uTime * 1.5, -uTime * 1.0));
                  float churn = (1.0 - smoothstep(0.55, 0.95, r)) * (0.4 + 0.6 * churnN);
                  float streak = vnoise(vec2(r * 6.0, ang * 2.5 + uTime * 0.7));
                  float streakF = smoothstep(0.55, 0.85, streak) * smoothstep(0.15, 0.6, r) * (1.0 - smoothstep(0.8, 1.0, r));
                  washFoam += w.z * (ring * 0.9 + churn * 0.55 + streakF * 0.45);
                  washFlat = max(washFlat, w.z * (1.0 - smoothstep(0.7, 1.0, r)));
                }
              }
            }
          }
          vec3 N = normalize(vNormal);
          vec2 g1 = vec2(0.0);
          { vec2 rp = wp * 0.6 + vec2(uTime * 0.4, -uTime * 0.25); float e = 0.6;
            g1 = vec2(vnoise(rp) - vnoise(rp + vec2(e, 0.0)), vnoise(rp) - vnoise(rp + vec2(0.0, e))); }
          vec2 g2 = vec2(0.0);
          { vec2 rp = wp * 1.7 + vec2(-uTime * 0.3, uTime * 0.5); float e = 0.35;
            g2 = vec2(vnoise(rp) - vnoise(rp + vec2(e, 0.0)), vnoise(rp) - vnoise(rp + vec2(0.0, e))); }
          vec2 g3 = vec2(0.0);
          { vec2 rp = wp * 4.5 + vec2(uTime * 0.6, uTime * 0.35); float e = 0.2;
            g3 = vec2(vnoise(rp) - vnoise(rp + vec2(e, 0.0)), vnoise(rp) - vnoise(rp + vec2(0.0, e))); }
          vec2 g4 = vec2(0.0);
          { vec2 rp = wp * 9.0 + vec2(-uTime * 0.8, uTime * 0.7); float e = 0.12;
            g4 = vec2(vnoise(rp) - vnoise(rp + vec2(e, 0.0)), vnoise(rp) - vnoise(rp + vec2(0.0, e))); }
          // v1.4.2: inside a downwash disc the blast presses the water
          // flat — the ripple normals are suppressed there, so the disc
          // reads as flattened water, not ordinary chop.
          N.xz += detailFade * (1.0 - clamp(washFlat, 0.0, 0.9)) * (0.28 * g1 + 0.16 * g2 + 0.14 * g3 + 0.08 * g4);
          N = normalize(N);
          float ndv = max(dot(N, V), 0.0);
          vec3 water = mix(uDeep, uBase, smoothstep(-0.15, 0.45, vH));
          water = mix(water, uCrest, smoothstep(0.55, 1.0, vH) * 0.65);
          float sss = pow(max(dot(V, -uSunDir), 0.0), 3.0) * smoothstep(0.25, 1.0, vH) * (0.6 + 0.4 * smoothstep(0.3, 0.8, vSteep));
          water += vec3(0.05, 0.65, 0.60) * sss * 1.0;
          float F = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
          vec3 col = mix(water, uSky, F * 0.85);
          vec3 H = normalize(V + uSunDir);
          float ndh = max(dot(N, H), 0.0);
          col += vec3(1.0, 0.95, 0.8) * (pow(ndh, 300.0) * 3.0 + pow(ndh, 60.0) * 0.5) * uSunI;
          float n = vnoise(wp * 0.35) * 0.6 + vnoise(wp * 1.3) * 0.4;
          float foamGate = smoothstep(0.20, 0.60, vSteep) * smoothstep(0.55, 0.85, vH);
          float foam = smoothstep(0.45, 0.95, foamGate + (n - 0.5) * 0.55) * 0.45;
          foam *= smoothstep(0.35, 0.75, uWindStr);
          foam *= exp(-dist / 200.0);
          float churnN = vnoise(wp * 1.5 + vec2(uTime * 1.5, -uTime * 1.0));
          float shipFoam = 0.0;
          for(int i = 0; i < ${MAXS}; i++){
            if(uShipSize[i].x > 1.0){
              vec2 d = wp - uShips[i].xy;
              if(abs(d.x) < 400.0 && abs(d.y) < 400.0){
                float ch = cos(uShips[i].z), sn = sin(uShips[i].z);
                float lx = d.x * ch + d.y * sn;
                float lz = -d.x * sn + d.y * ch;
                float hl = uShipSize[i].x * 0.5;
                float hb = uShipSize[i].y * 0.5;
                float spd = abs(uShips[i].w);
                float spdF = smoothstep(0.0, 8.0, spd);
                float lzC = clamp(lz, -hl, hl);
                float segD = length(vec2(lx, lz - lzC));
                float w = segD - hb;
                float band = smoothstep(0.0, 1.0, w) * (1.0 - smoothstep(1.0, 4.0, w));
                float bowW = 0.6 + 0.4 * smoothstep(0.0, hl, -lz);
                float hullF = band * spdF * (0.5 + 0.2 * churnN) * bowW;
                float trail = (uShips[i].w >= 0.0) ? (lz - hl) : (-lz - hl);
                float wakeF = 0.0;
                if(trail > 0.0 && trail < 45.0){
                  float armD = min(abs(lx * 0.943 - trail * 0.334), abs(lx * 0.943 + trail * 0.334));
                  float armF = (1.0 - smoothstep(0.0, 3.5, armD)) * (1.0 - smoothstep(8.0, 45.0, trail));
                  float washW = 4.0 + trail * 0.15;
                  float washF = (1.0 - smoothstep(0.0, washW, abs(lx))) * (1.0 - smoothstep(5.0, 35.0, trail));
                  wakeF = (armF * 0.25 + washF * 0.35) * spdF * (0.6 + 0.2 * churnN);
                }
                shipFoam += hullF + wakeF;
              }
            }
          }
          shipFoam = min(shipFoam, 1.0) * exp(-dist / 260.0);
          vec2 wPerp = vec2(-uWind.y, uWind.x);
          vec2 streakUV = vec2(dot(wp, wPerp), dot(wp, uWind) * 0.15);
          float streak = vnoise(streakUV * 0.55 + vec2(0.0, uTime * 0.25));
          float streakF = smoothstep(0.6, 0.9, streak) * smoothstep(0.4, 0.8, uWindStr) * 0.35 * smoothstep(0.4, 0.7, vH) * exp(-dist / 260.0);
          col = mix(col, uFoam, clamp(foam + shipFoam + streakF + washFoam, 0.0, 1.0) * 0.35);
          // v1.4.2: the downwash foam gets its own stronger pass — a
          // full-strength blast reads whiter than ordinary wave foam.
          col = mix(col, uFoam, clamp(washFoam, 0.0, 1.0) * 0.45);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    this.ocean = new THREE.Mesh(g, mat);
    this.ocean.frustumCulled = false;
    scene.add(this.ocean);
    // v1.6.0 Item 2: the visual seabed — a dark sandy disc at SEA_FLOOR_Y,
    // wide enough to cover the ocean (radius 3000 m). MeshBasicMaterial so
    // it reads through the underwater murk fog; it follows the ocean focus
    // in update() like the surface does, so the floor never ends mid-map.
    const floorGeo = new THREE.CircleGeometry(3200, 64);
    this.floor = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({ color: 0x4a4238 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = SEA_FLOOR_Y;
    scene.add(this.floor);
    this._frame = 0;
  }
  setStage(i) {
    this.stageIdx = i;
    const s = STAGES[i];
    this.ampTarget = s.amp;
    this.buildSpectrum(s.wind);
    this.uniforms.uWindStr.value = s.wind / 20;
    this.uniforms.uSky.value.setHex(s.sky);
    this.uniforms.uBase.value.setHex(s.sea);
    this.uniforms.uSunI.value = s.sunI;
  }
  // ships: [{x,z,heading,forwardSpeed,len,beam, onWater}] — only hulls at/near
  // the water feed the wake uniforms; flying carriers skip (no wake in the sky).
  // wash: [{x,z,strength,radius}] — v1.4.2 rotor-downwash sources, one per
  // live lift pod (see game.js); strength 0 = no source. Pass [] or null
  // for none (e.g. the attract scene behind the menu).
  update(t, dt, focusX, focusZ, ships, wash) {
    this.ampCur += (this.ampTarget - this.ampCur) * Math.min(1, dt * 0.5);
    this.uniforms.uTime.value = t;
    const OCEAN_STEP = 8;
    const mx = Math.round(focusX / OCEAN_STEP) * OCEAN_STEP;
    const mz = Math.round(focusZ / OCEAN_STEP) * OCEAN_STEP;
    this.ocean.position.set(mx, 0, mz);
    if (this.floor) this.floor.position.set(mx, SEA_FLOOR_Y, mz); // v1.6.0 Item 2: seabed follows the focus
    const pos = this.oceanPos.array, base = this.oceanBase;
    const nrm = this.oceanNrm;
    const range = this.WAVE_AMP_SUM * this.ampCur + 0.1;
    for (let i = 0; i < this.oceanPos.count; i++) {
      const bx = base[i * 3], bz = base[i * 3 + 2];
      const g = this.gerstner(mx + bx, mz + bz, t);
      pos[i * 3] = bx + (g.x - (mx + bx));
      pos[i * 3 + 1] = g.y;
      pos[i * 3 + 2] = bz + (g.z - (mz + bz));
      this.oceanH[i] = (g.y / range) * 0.5 + 0.5;
      // v1.6.0 perf: analytic normal + steepness from the same pass.
      // Replaces computeVertexNormals() (every other frame) + the
      // normal scan: the Gerstner field is smooth, so the analytic
      // normal (-dydx, 1, -dydz) matches the discretised one to ~1e-3
      // and is fresh every frame instead of every other one.
      const inv = 1 / Math.sqrt(g.dydx * g.dydx + 1 + g.dydz * g.dydz);
      nrm[i * 3] = -g.dydx * inv; nrm[i * 3 + 1] = inv; nrm[i * 3 + 2] = -g.dydz * inv;
      this.oceanSteep[i] = Math.min(1, Math.max(0, (1 - inv) * 3));
    }
    this.oceanPos.needsUpdate = true;
    this.oceanGeo.attributes.normal.needsUpdate = true;
    this.oceanGeo.attributes.aSteep.needsUpdate = true;
    this.oceanGeo.attributes.aH.needsUpdate = true;
    for (let i = 0; i < this.MAXS; i++) {
      const s = ships && ships[i];
      if (s) {
        this.uniforms.uShips.value[i].set(s.x, s.z, s.heading, s.forwardSpeed || 0);
        this.uniforms.uShipSize.value[i].set(s.len || 0, s.beam || 0);
      } else {
        this.uniforms.uShips.value[i].set(0, 0, 0, 0);
        this.uniforms.uShipSize.value[i].set(0, 0);
      }
    }
    for (let i = 0; i < this.WASH_MAX; i++) {
      const w = wash && wash[i];
      if (w) this.uniforms.uWash.value[i].set(w.x, w.z, w.strength || 0, w.radius || 0);
      else this.uniforms.uWash.value[i].set(0, 0, 0, 0);
    }
  }
}
