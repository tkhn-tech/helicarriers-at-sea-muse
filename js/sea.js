// sea.js — JONSWAP spectrum + Gerstner ocean, lifted from Hurricane Fleet
// (index.html L796-975, L1024-1300) and converted to METRIC scale:
// Hurricane ran 1 unit ≈ 5.74 m (GAME_M = 5.74, G_GAME = 9.81/5.74).
// This game is 1 unit = 1 m, so GAME_M = 1 and G_GAME = 9.81. All other
// constants (fetch 300 km, gamma 3.3, 14 wind-sea + 4 swell components,
// equal-variance quantiles, m0 fetch law) are verbatim.
import * as THREE from 'three';

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
  gerstner(x, z, t) {
    let y = 0, ox = 0, oz = 0;
    const W = this.WAVES;
    for (let i = 0; i < W.length; i++) {
      const w = W[i];
      const th = w.k * (w.dx * x + w.dz * z) - w.w * t + w.ph;
      const A = w.amp * this.ampCur;
      const Q = Math.min(w.q, 1 / Math.max(0.001, w.k * A));
      ox += Q * A * w.dx * Math.cos(th);
      oz += Q * A * w.dz * Math.cos(th);
      y += A * Math.sin(th);
    }
    y += this.freakHeightAt(x, z);
    return { x: x + ox, y, z: z + oz };
  }
  waveHeight(x, z, t) { return this.gerstner(x, z, t).y; }
  // The shared ocean query — verbatim structure from Hurricane L907-957.
  getOceanDataAt(x, z, t) {
    let y = 0, dydx = 0, dydz = 0, doxdx = 0, doxdz = 0, dozdx = 0, dozdz = 0, ovx = 0, ovy = 0, ovz = 0;
    const W = this.WAVES;
    for (let i = 0; i < W.length; i++) {
      const w = W[i];
      const th = w.k * (w.dx * x + w.dz * z) - w.w * t + w.ph;
      const A = w.amp * this.ampCur;
      const Q = Math.min(w.q, 1 / Math.max(0.001, w.k * A));
      const sn = Math.sin(th), cs = Math.cos(th);
      y += A * sn;
      dydx += A * w.k * w.dx * cs; dydz += A * w.k * w.dz * cs;
      doxdx += -Q * A * w.k * w.dx * w.dx * sn; doxdz += -Q * A * w.k * w.dx * w.dz * sn;
      dozdx += -Q * A * w.k * w.dz * w.dx * sn; dozdz += -Q * A * w.k * w.dz * w.dz * sn;
      ovx += Q * A * w.dx * w.w * sn; ovy += -A * w.w * cs; ovz += Q * A * w.dz * w.w * sn;
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
    const MAXS = 12; // uShips[12]: up to 8 carriers + 4 wreck slots (was 8 in Hurricane)
    const shipVecs = [], shipSizes = [];
    for (let i = 0; i < MAXS; i++) { shipVecs.push(new THREE.Vector4()); shipSizes.push(new THREE.Vector2()); }
    this.MAXS = MAXS;
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
          N.xz += detailFade * (0.28 * g1 + 0.16 * g2 + 0.14 * g3 + 0.08 * g4);
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
          col = mix(col, uFoam, clamp(foam + shipFoam + streakF, 0.0, 1.0) * 0.35);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    this.ocean = new THREE.Mesh(g, mat);
    this.ocean.frustumCulled = false;
    scene.add(this.ocean);
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
  update(t, dt, focusX, focusZ, ships) {
    this.ampCur += (this.ampTarget - this.ampCur) * Math.min(1, dt * 0.5);
    this.uniforms.uTime.value = t;
    const OCEAN_STEP = 8;
    const mx = Math.round(focusX / OCEAN_STEP) * OCEAN_STEP;
    const mz = Math.round(focusZ / OCEAN_STEP) * OCEAN_STEP;
    this.ocean.position.set(mx, 0, mz);
    const pos = this.oceanPos.array, base = this.oceanBase;
    const range = this.WAVE_AMP_SUM * this.ampCur + 0.1;
    for (let i = 0; i < this.oceanPos.count; i++) {
      const bx = base[i * 3], bz = base[i * 3 + 2];
      const g = this.gerstner(mx + bx, mz + bz, t);
      pos[i * 3] = bx + (g.x - (mx + bx));
      pos[i * 3 + 1] = g.y;
      pos[i * 3 + 2] = bz + (g.z - (mz + bz));
      this.oceanH[i] = (g.y / range) * 0.5 + 0.5;
    }
    this.oceanPos.needsUpdate = true;
    if ((this._frame++ & 1) === 0) {
      this.oceanGeo.computeVertexNormals();
      const nrm = this.oceanGeo.attributes.normal.array;
      for (let i = 0; i < this.oceanPos.count; i++) this.oceanSteep[i] = Math.min(1, Math.max(0, (1 - nrm[i * 3 + 1]) * 3));
      this.oceanGeo.attributes.aSteep.needsUpdate = true;
      this.oceanGeo.attributes.aH.needsUpdate = true;
    }
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
  }
}
