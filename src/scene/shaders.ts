/**
 * GLSL for the night scene. One fragment shader evaluates the scene at the centres
 * of "scene pixels"; the pixel size is the era: a few CSS px in 1997, a device px in 2026.
 * Both eras share the geometry (moon, horizon, waves, curtain glow); only shading differs.
 * The same source also builds two coarse maps first: the aurora light and the sky without
 * stars, which the scene samples instead of tracing the aurora per pixel. Each pass is its own
 * program (sceneFs): one shader for all of them took Direct3D (ANGLE) about 30 s to compile.
 */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const SCENE_UNIFORMS = [
  'uCss', 'uPix', 'uTexSize', 'uHorizon', 'uMoon', 'uTime', 'uMode', 'uMix', 'uMotion', 'uMeteor', 'uLevels', 'uDither',
  'uPointer', 'uCell', 'uColsN', 'uRayFreq', 'uMoonMaps', 'uMoonTexels', 'uCurtainView',
  'uMoonTex', 'uColumns', 'uCurtain', 'uAlbedoMap', 'uNormalMap',
  'uAuroraTex', 'uSkyTex', 'uAuroraSpan', 'uSkySpan', 'uSkyTexel',
  'uAurora', 'uFft', 'uSeaTile', 'uSeaTexel', 'uSeaLam', 'uSeaHeight', 'uLost', 'uSeaA0', 'uSeaB0', 'uSeaA1', 'uSeaB1', 'uSeaA2', 'uSeaB2',
] as const;

const SCENE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 outColor;

uniform vec2 uCss;
uniform float uPix;
uniform vec2 uTexSize;
uniform float uHorizon;
uniform vec3 uMoon;
uniform float uTime;
uniform int uMode;
uniform float uMix;
uniform float uMotion;
uniform vec2 uMeteor;
uniform float uLevels;
uniform float uDither;
uniform vec3 uPointer;
uniform float uCell;
uniform float uColsN;
uniform float uRayFreq;
uniform float uMoonMaps;
uniform float uMoonTexels;
uniform vec2 uCurtainView;
uniform sampler2D uMoonTex;
uniform sampler2D uColumns;
uniform sampler2D uCurtain;
uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uAuroraTex;
uniform sampler2D uSkyTex;
uniform vec2 uAuroraSpan;
uniform vec2 uSkySpan;
uniform float uSkyTexel;
uniform float uAurora;
uniform float uFft;
uniform vec3 uSeaTile;
uniform vec3 uSeaTexel;
uniform vec3 uSeaLam;
uniform float uSeaHeight;
uniform float uLost[32];
uniform sampler2D uSeaA0;
uniform sampler2D uSeaB0;
uniform sampler2D uSeaA1;
uniform sampler2D uSeaB1;
uniform sampler2D uSeaA2;
uniform sampler2D uSeaB2;

const float PI = 3.14159265;
const float NOMINAL_PIXEL = 4.0;

// ---------------------------------------------------------------- hashing / noise
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hashCell(ivec2 c) {
  uint h = uint(c.x) * 374761393u + uint(c.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return float(h ^ (h >> 16u)) / 4294967296.0;
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 7.1) + 0.125 * vnoise(p * 4.1 + 3.7);
}

const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
float bayer(ivec2 c) {
  return (BAYER[(c.y & 3) * 4 + (c.x & 3)] + 0.5) / 16.0;
}

// ---------------------------------------------------------------- 1997 palettes (backdrop.ts)
const vec3 INK[8] = vec3[8](
  vec3(0., 0., 0.), vec3(5., 10., 12.) / 255., vec3(12., 22., 26.) / 255., vec3(28., 44., 50.) / 255.,
  vec3(62., 84., 90.) / 255., vec3(120., 140., 144.) / 255., vec3(200., 212., 210.) / 255., vec3(246., 248., 240.) / 255.);
const vec3 GLOW[5] = vec3[5](
  vec3(0., 0., 0.), vec3(4., 26., 26.) / 255., vec3(8., 48., 40.) / 255., vec3(20., 84., 52.) / 255., vec3(52., 128., 56.) / 255.);
const vec3 MOON_INK[9] = vec3[9](
  vec3(14., 24., 28.) / 255., vec3(34., 50., 56.) / 255., vec3(62., 82., 88.) / 255., vec3(92., 112., 116.) / 255.,
  vec3(124., 142., 144.) / 255., vec3(158., 172., 170.) / 255., vec3(192., 204., 200.) / 255.,
  vec3(224., 232., 226.) / 255., vec3(250., 252., 244.) / 255.);

float rampIndex(float value, float steps, float threshold) {
  float s = clamp(value, 0., 1.) * steps;
  float lo = floor(s);
  return min(steps, lo + ((s - lo) > threshold ? 1. : 0.));
}
vec3 shadeInk(float v, float t) { return INK[int(rampIndex(v, 7., t))]; }
vec3 shadeGlow(float v, float t) { return GLOW[int(rampIndex(v, 4., t))]; }
vec3 shadeMoon(float v, float t) { return MOON_INK[int(rampIndex(v, 8., t))]; }

// ---------------------------------------------------------------- shared scene geometry
float archEdge(float u) { float d = abs(2. * u - 1.); return 1. - d * d; }
float archReach(float u) { return 0.42 + 0.58 * archEdge(u); }
float archGain(float u) { return 0.62 + 0.38 * archEdge(u); }

float rayAt(float column, float t) {
  float c = column * uRayFreq;
  float band = 0.5 + 0.5 * sin(c * 0.085 + 2.4 * sin(c * 0.037 + t * 0.15) + t * 0.22);
  float streak = 0.5 + 0.5 * sin(c * 0.31 - t * 0.35);
  return 0.06 + pow(band, 1.7) * (0.65 + 0.35 * streak);
}

/** (shift px, fold) of the curtain at a CSS x position. */
vec2 columnAt(float x) {
  return texture(uColumns, vec2((x / uCell + 0.5) / uColsN, 0.5)).rg;
}

/** Aurora glow behind the curtain in [0, ~1]; follows the cloth. */
float auroraAt(vec2 p) {
  float u = clamp(p.x / uCss.x, 0., 1.);
  float yr = (p.y / uHorizon) / archReach(u);
  if (yr >= 1.) return 0.;
  vec2 cf = columnAt(p.x);
  float profile = smoothstep(0., 0.14, yr) * pow(1. - yr, 1.4) * 1.15 * archGain(u);
  return profile * rayAt((p.x - cf.x) / uCell, uTime) * (0.7 + cf.y);
}

// waves: direction*frequency, angular speed, amplitude. The first three are the 1997 swell.
const vec2 WK[13] = vec2[13](vec2(0.8, 0.9), vec2(-1.5, 0.65), vec2(2.7, 1.9), vec2(0.35, 0.55), vec2(4.6, 2.9), vec2(-6.8, 3.9), vec2(9.5, -5.1),
  vec2(11., 6.), vec2(-9., 13.), vec2(17., -8.), vec2(6., -21.), vec2(-24., 11.), vec2(14., 27.));
const float WW[13] = float[13](0.55, 0.9, 1.35, 0.25, 2.0, 2.6, 3.1, 2.4, 2.9, 3.3, 3.8, 4.2, 4.7);
const float WA[13] = float[13](0.55, 0.3, 0.2, 0.45, 0.06, 0.035, 0.02, 0.04, 0.028, 0.021, 0.016, 0.011, 0.009);

/** Slope variance of the waves too fine for the current pixel; folded into roughness instead of aliasing. */
float waveLost = 0.;

/**
 * Height and gradient of the sea at plane position P. count = 3 is the plain 1997 sine
 * swell; count = 7 adds a long swell and ripples and bends positions Gerstner-style so
 * crests sharpen. Waves finer than the pixel footprint fp fade out instead of aliasing.
 */
void waveField(vec2 P, float t, float fp, int count, out float eta, out vec2 grad) {
  eta = 0.;
  grad = vec2(0.);
  waveLost = 0.;
  vec2 bend = vec2(0.);
  if (count > 3) {
    for (int i = 0; i < 4; i++) bend += 0.55 * WA[i] * normalize(WK[i]) * cos(dot(WK[i], P) + WW[i] * t);
  }
  vec2 Q = P + bend;
  for (int i = 0; i < 13; i++) {
    if (i >= count) break;
    float keep = 1. - smoothstep(0.9, 2.0, length(WK[i]) * fp);
    float lostSlope = WA[i] * length(WK[i]) * (1. - keep);
    waveLost += 0.5 * lostSlope * lostSlope;
    float a = WA[i] * keep;
    float ph = dot(WK[i], Q) + WW[i] * t;
    eta += a * sin(ph);
    grad += a * cos(ph) * WK[i];
  }
}

// ---------------------------------------------------------------- stars (shared catalogue)
const float STAR_CELL = 62.0;
struct Star { vec2 pos; float level; float speed; float phase; float cross; vec3 tint; };
Star starOf(vec2 id) {
  Star s;
  float roll = hash21(id * 1.7 + 3.1);
  s.pos = (id + 0.1 + 0.8 * hash22(id + 17.3)) * STAR_CELL;
  s.level = roll > 0.94 ? 0.95 : (roll > 0.7 ? 0.62 : 0.36);
  s.speed = hash21(id * 2.3 + 9.7) < 0.35 ? 0.6 + 1.8 * hash21(id + 5.5) : 0.;
  s.phase = 6.28 * hash21(id + 8.8);
  s.cross = roll > 0.985 ? 1. : 0.;
  s.tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.88, 0.72), hash21(id + 1.9));
  return s;
}
// The sky turns very slowly around an off-screen pole; stars live in catalogue space.
const float SKY_SPIN = 0.00005;
const float STAR_REACH = 30.;
vec2 skyPole() { return vec2(uCss.x * 0.2, -uCss.y * 0.9); }
vec2 rotateAbout(vec2 p, float a) {
  vec2 q = p - skyPole();
  float c = cos(a);
  float s = sin(a);
  return skyPole() + vec2(c * q.x - s * q.y, s * q.x + c * q.y);
}
vec2 toCatalogue(vec2 p) { return rotateAbout(p, -uTime * SKY_SPIN * uMotion); }
vec2 fromCatalogue(vec2 p) { return rotateAbout(p, uTime * SKY_SPIN * uMotion); }

/** Star visibility: almost none next to the moon, full toward the sky edges. */
float starVisibility(vec2 p) {
  return smoothstep(0.05, 1.1, (length(p - uMoon.xy) - uMoon.z) / uMoon.z);
}

/**
 * Scintillation: smooth per-star noise, nearly still high in the sky, stronger and faster
 * toward the horizon. low (1 at the horizon) also drives a slight colour flicker.
 */
float scintillation(Star s, vec2 sp, out float low, out float chroma) {
  float alt = clamp((uHorizon - sp.y) / uHorizon, 0., 1.);
  low = pow(1. - alt, 2.5);
  float speed = 0.7 + 3.5 * low;
  float n = vnoise(vec2(uTime * speed + s.phase * 3., s.phase * 7.)) * 2. - 1.;
  chroma = (vnoise(vec2(uTime * speed * 1.3 + s.phase * 5., s.phase * 11. + 3.)) * 2. - 1.) * low * low;
  return 1. + (0.04 + 0.5 * low) * n * uMotion;
}

/** Faint shooting star, a few seconds long, now and then; always in the upper sky. */
float meteorAt(vec2 p) {
  if (uMotion < 0.5) return 0.;
  float slot = floor(uTime / uMeteor.x);
  if (hash21(vec2(slot, 7.3)) > uMeteor.y) return 0.;
  float dur = 1.0;
  float tau = uTime - slot * uMeteor.x - hash21(vec2(slot, 1.9)) * (uMeteor.x - dur - 0.2);
  if (tau < 0. || tau > dur) return 0.;
  vec2 start = vec2(uCss.x * (0.12 + 0.76 * hash21(vec2(slot, 3.1))), uHorizon * (0.06 + 0.32 * hash21(vec2(slot, 5.7))));
  float ang = radians(15. + 25. * hash21(vec2(slot, 9.2)));
  vec2 dir = vec2(hash21(vec2(slot, 2.2)) > 0.5 ? cos(ang) : -cos(ang), sin(ang));
  vec2 q = p - (start + dir * 260. * tau);
  float a = -dot(q, dir);
  float b = dot(q, vec2(-dir.y, dir.x));
  float streak = smoothstep(120., 0., a) * smoothstep(-2., 0.5, a) * exp(-b * b / 1.6);
  return streak * sin(3.14159 * tau / dur) * starVisibility(p) * step(p.y, uHorizon * 0.85);
}

// ---------------------------------------------------------------- moon
float moonLuma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 moonTexel(vec2 q, float lod) {
  q *= min(1., 0.994 / max(length(q), 0.0001));
  return textureLod(uMoonTex, q * 0.5 + 0.5, lod).rgb;
}

float moonLod(float footprint) {
  return log2(max(1., footprint * uMoonTexels / (2. * uMoon.z)));
}

float lommelSeeliger(float mu0, float mu) {
  return mu0 / (mu0 + mu + 0.02);
}

/**
 * The moon as a lit sphere: LRO albedo and LOLA relief mapped by longitude/latitude
 * (near side, equirectangular), shaded with a Lommel-Seeliger law. The light sits
 * slightly off the view axis, so relief shows only gently toward one limb.
 */
vec3 moonSphere(vec2 p, float footprint) {
  vec2 q = (p - uMoon.xy) / uMoon.z;
  q *= min(1., 0.998 / max(length(q), 0.0001));
  float mu = sqrt(max(1. - dot(q, q), 0.));
  vec3 P = vec3(q.x, -q.y, max(mu, 0.001));
  vec2 uv = vec2(atan(P.x, P.z) / PI + 0.5, 0.5 - asin(clamp(P.y, -1., 1.)) / PI);
  float texels = 1536. / PI * footprint / uMoon.z;
  float lod = min(log2(max(1., max(texels / max(P.z, 0.03), texels))) - 0.3, 3.4);

  float albedo = textureLod(uAlbedoMap, uv, max(lod + 0.35, 0.)).r;
  albedo = mix(0.6, albedo, 1.0);
  vec2 slope = (textureLod(uNormalMap, uv, max(lod + 0.4, 0.)).rg * 2. - 1.) * 0.25;
  vec3 E = normalize(vec3(P.z, 0., -P.x) + vec3(0.0001, 0., 0.));
  vec3 N = cross(P, E);
  vec3 nrm = normalize(P - 3.2 * (slope.x * E + slope.y * N));

  vec3 L = normalize(vec3(-0.30, 0.24, 1.0));
  vec3 V = vec3(0., 0., 1.);
  float mu0g = max(dot(P, L), 0.);
  float lsG = lommelSeeliger(mu0g, mu);
  float lsN = lommelSeeliger(max(dot(nrm, L), 0.), max(dot(nrm, V), 0.05));
  float relief = clamp(1. + 0.7 * (lsN - lsG) / max(lsG, 0.25), 0.4, 1.7);
  float shade = mix(0.78, 1.0, pow(mu0g, 0.45)) * (0.88 + 0.12 * pow(mu, 0.4));

  vec3 lin = pow(vec3(albedo), vec3(2.2 * 1.25));
  return lin * shade * relief * 5.0 * vec3(1.0, 0.985, 0.96);
}

/** Photographic fallback used until the surface maps have arrived. */
vec3 moonPhoto(vec2 p, float footprint) {
  vec2 q = (p - uMoon.xy) / uMoon.z;
  float mu = sqrt(max(1. - dot(q, q), 0.));
  float lod = moonLod(footprint);
  vec3 a = moonTexel(q, lod);
  a = mix(vec3(dot(a, vec3(0.2126, 0.7152, 0.0722))), a, 0.35);
  float lam = max(dot(vec3(q.x, -q.y, mu), normalize(vec3(-0.30, 0.24, 1.0))), 0.);
  float shade = mix(0.58, 1.0, pow(lam, 0.55)) * (0.80 + 0.20 * pow(mu, 0.5));
  return pow(a, vec3(2.2 * 1.3)) * shade * 4.8;
}

/** Moon radiance with atmospheric extinction: dimmer and warmer near the horizon, slightly cool high up. */
vec3 moonReal(vec2 p, float footprint) {
  vec3 col = uMoonMaps > 0.5 ? moonSphere(p, footprint) : moonPhoto(p, footprint);
  float h = (uHorizon - p.y) / uMoon.z;
  col *= mix(vec3(0.50, 0.36, 0.26), vec3(1.), smoothstep(0., 0.5, h));
  col *= mix(vec3(1.), vec3(0.96, 0.99, 1.04), smoothstep(0.5, 1.1, h));
  return col;
}

// ---------------------------------------------------------------- 1997 sky level (continuous, before dithering)
float haloLevel(vec2 p) {
  float v = 0.34 * exp(-(uHorizon - p.y) / (uCss.y * 0.045));
  float o = max(length(p - uMoon.xy) - uMoon.z, 0.);
  return v + 0.34 * exp(-o / (uMoon.z * 0.05)) + 0.26 * exp(-o / (uMoon.z * 0.25)) + 0.16 * exp(-o / (uMoon.z * 0.9));
}

// ---------------------------------------------------------------- real sky
vec3 starGlow(vec2 pc, vec2 p, vec2 id) {
  Star s = starOf(id);
  vec2 sp = fromCatalogue(s.pos);
  if (sp.y > uHorizon * 0.97) return vec3(0.);
  vec2 d = pc - s.pos;
  float dist = length(d);
  if (dist > STAR_REACH) return vec3(0.);
  float low;
  float chroma;
  float l = s.level * scintillation(s, sp, low, chroma);
  float sigma = 0.5 + 0.55 * l;
  float v = exp(-dist * dist / (2. * sigma * sigma)) * l * l * 2.4;
  v += l * l * 0.12 * exp(-dist / (1.6 + 5. * l));
  // Diffraction spikes only on the few brightest stars, gently breathing.
  float breath = 0.75 + 0.25 * sin(uTime * 0.7 * uMotion + s.phase);
  v += s.cross * breath * l * 0.5 * (exp(-abs(d.x) * 1.2) * exp(-abs(d.y) * 0.18) + exp(-abs(d.y) * 1.2) * exp(-abs(d.x) * 0.18)) * 0.5;
  float pl = uPointer.z * exp(-pow(length(p - uPointer.xy) / 90., 2.));
  v *= 1. + pl * 1.6;
  vec3 tint = s.tint * vec3(1. + 0.5 * chroma, 1., 1. - 0.5 * chroma);
  return tint * v;
}

/** Stars from the 3x3 neighbourhood, so glow and spikes are never clipped at cell borders. */
vec3 stars(vec2 p) {
  vec2 pc = toCatalogue(p);
  vec2 cell = floor(pc / STAR_CELL);
  vec2 f = (pc / STAR_CELL - cell) * STAR_CELL;
  vec3 acc = vec3(0.);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx < 0 && f.x > STAR_REACH) continue;
      if (dx > 0 && STAR_CELL - f.x > STAR_REACH) continue;
      if (dy < 0 && f.y > STAR_REACH) continue;
      if (dy > 0 && STAR_CELL - f.y > STAR_REACH) continue;
      acc += starGlow(pc, p, cell + vec2(float(dx), float(dy)));
    }
  }
  return acc * starVisibility(p) + vec3(0.75, 0.85, 1.0) * meteorAt(p) * 0.9;
}

vec3 dust(vec2 p) {
  vec2 uv = p / uCss;
  float bd = dot(uv - vec2(0.55, 0.3), normalize(vec2(0.62, -0.78)));
  float band = exp(-bd * bd * 22.);
  float cloud = 0.35 + 0.65 * fbm(p * 0.007 + 4.);
  vec3 col = vec3(0.55, 0.65, 0.9) * band * cloud * 0.012;
  vec2 c = floor(p / 6.);
  float h = hash21(c);
  float tiny = step(0.985 - 0.06 * band, h) * (0.05 + 0.1 * hash21(c + 3.));
  vec2 f = fract(p / 6.) - 0.5 - 0.3 * (hash22(c + 9.) - 0.5);
  col += vec3(0.8, 0.85, 1.) * tiny * exp(-dot(f, f) * 22.) * (0.4 + band);
  return col;
}

float gAurora = 1.;
float gAuroraNew = 1.;


/*
 * Aurora as geometry. Distances are in km, the camera sits at the origin looking along +z. A sheet is a
 * vertical curtain over a ground curve z = Z(x); a pixel ray (x, y, 1) * z meets it where z = Z(x * z), at
 * altitude y * z. Seen edge-on a fold lets the ray travel inside the sheet, so it glows brighter.
 */
float auroraSheetZ(int k, float x, out float slope) {
  if (k == 0) {
    // Main ribbon: diagonal from the near upper left to the far right, folded into S-curves.
    float a = x * 0.0075 + 1.2;
    float b = x * 0.019 + 0.4;
    slope = -0.9 + 0.75 * cos(a) + 0.32 * cos(b);
    return 1000. - 0.95 * x + 100. * sin(a) + 17. * sin(b);
  }
  // Faint secondary band, far away, leaning the other way.
  float a = x * 0.007 + 2.;
  float b = x * 0.021 + 1.;
  slope = -0.35 + 0.42 * cos(a) + 0.5 * cos(b);
  return 1000. - 0.35 * (x - 100.) + 60. * sin(a) + 25. * sin(b);
}

/** Light of one sheet crossing at distance z: thickness along the ray, height profile, colour layers, rays. */
vec3 auroraCrossing(int k, float z, float ux, float uy) {
  float x = ux * z;
  float alt = uy * z;
  float slope;
  float zc = auroraSheetZ(k, x, slope);
  float cosT = abs(1. - slope * ux) / (sqrt(1. + slope * slope) * sqrt(1. + ux * ux));
  float edge = min(1. / max(cosT, 0.3), 3.);

  float t = uTime;
  // The lower border wanders along the ribbon and in time; the ribbon's height changes slowly too.
  float hb = 90. + 30. * vnoise(vec2(x / 140. + t * 0.012, float(k) * 7. + 1.)) + 7. * vnoise(vec2(x / 22. - t * 0.05, 9. + float(k)));
  // Small folds ripple along the hem.
  hb += 4. * sin(x / 35. + t * 0.4 + float(k) * 2.);
  float hh = alt - hb;
  float tall = vnoise(vec2(x / 170. - t * 0.02, 3. + float(k) * 5.));
  float topH = 90. + 150. * smoothstep(0.2, 0.8, tall) + 60. * smoothstep(0., 700., x);
  if (hh < -70. || hh > topH * 2.3) return vec3(0.);

  // Magnetic field lines: footpoints fan toward a vanishing point above the frame, so rays converge upward.
  // The lean is capped, otherwise the far end of the ribbon turns into steep diagonal strokes.
  float fan = clamp(alt, 0., 300.) / 700.;
  float x0 = x + clamp(x - 140., -350., 350.) * fan / (1. - fan) + float(k) * 91.;
  // Ray widths grow with distance so they keep the same width on screen; at true size the far end of
  // the ribbon breaks into hairlines that no camera or eye would resolve.
  float rs = clamp(z / 700., 1., 3.5);
  // Soft, low-contrast striation (about 15%) and gentle brightness drift along the band, never dropping out.
  float thin = vnoise(vec2(x0 / (7. * rs) + t * 0.12, 1.7));
  float wide = vnoise(vec2(x0 / (30. * rs) - t * 0.06, 5.3));
  float rays = 0.88 + 0.24 * thin;
  float blob = 0.75 + 0.5 * vnoise(vec2(x0 / 160. + 3., t * 0.04)) + 0.2 * (wide - 0.5);
  float surge = 1. + 0.3 * exp(-pow((mod(t, 100.) - 50.) / 9., 2.));
  // Shimmer: rays flicker on their own at about 1 Hz, and soft brightness waves run along the band.
  float flick = 0.8 + 0.4 * vnoise(vec2(x0 / (10. * rs) + t * 0.35, t * 1.1 + float(k) * 4.));
  float pulse = 1. + 0.12 * sin(x / 45. - t * 0.8 + 2. * vnoise(vec2(x / 300., t * 0.05)));
  float strength = rays * blob * surge * flick * pulse;

  // Sharp bright lower hem, exponential fade upward.
  // Each ray ends at its own height (a fraction of the local ribbon height).
  float rayTop = topH * (0.55 + 0.7 * vnoise(vec2(x0 / (5. * rs) + 20., t * 0.03)));
  float hs = hh / max(rayTop, 30.);
  // Soft hem: a smooth rise over ~8 km, no step; exponential fade upward scaled by the ribbon height.
  float prof = smoothstep(-60., 12., hh) * exp(-max(hh, 0.) / (0.38 * rayTop + 28.));
  prof *= 1. - smoothstep(0.35, 1.7, hs);
  float hot = exp(-pow((hh - 8.) / 22., 2.));
  float pink = exp(-pow((hh + 6.) / 16., 2.));
  float red = smoothstep(0.5, 1.4, hs) * exp(-hs * 1.5);

  vec3 c = vec3(0.10, 1.0, 0.36) * (prof * (0.75 + 0.5 * hot) * (0.7 + 0.5 * rayTop / 200.));
  c += vec3(0.95, 0.22, 0.6) * pink * 0.07;
  c += vec3(0.8, 0.06, 0.12) * red * 0.05;
  float ends = 0.35 + 0.65 * smoothstep(-1200., -300., x) * (1. - smoothstep(900., 1800., x));
  return c * strength * edge * ends * exp(-z / 2400.) * 0.42;
}

vec3 auroraSheet(int k, float ux, float uy) {
  float zLo = max(35. / uy, 150.);
  float zHi = min(560. / uy, 2400.);
  if (zHi <= zLo) return vec3(0.);
  int steps = uCss.x < 900. ? 8 : 12;
  float dz = (zHi - zLo) / float(steps);
  float slope;
  float zPrev = zLo;
  float gPrev = zPrev - auroraSheetZ(k, ux * zPrev, slope);
  vec3 acc = vec3(0.);
  for (int i = 1; i <= 12; i++) {
    if (i > steps) break;
    float z = zLo + dz * float(i);
    float g = z - auroraSheetZ(k, ux * z, slope);
    if (gPrev * g <= 0.) {
      float zs = mix(zPrev, z, gPrev / (gPrev - g + 1e-6));
      float gs = zs - auroraSheetZ(k, ux * zs, slope);
      zs -= gs / max(0.2, 1. - slope * ux);
      acc += auroraCrossing(k, zs, ux, uy);
    }
    zPrev = z;
    gPrev = g;
  }
  return acc;
}

/** Narrow screens zoom in (a longer virtual lens), otherwise the huge moon would hide the whole ribbon. */
float auroraLens() {
  return uCss.x < 900. ? 2. * uCss.x : uCss.x;
}

/** Soft focus: a few taps spread over the screen blur the light into a diffuse glow. */
const float AURORA_BLUR = 0.035;

/**
 * Aurora emission (linear, additive): a fragment of a huge ribbon seen through a telephoto view, so no
 * symmetric arch. It moves only on its own; the pointer does not touch it.
 * Colour layers: pink lower border, green 557.7 nm body, faint red 630 nm top.
 * The aurora map stores single taps; auroraLight adds the soft focus on lookup.
 */
vec3 auroraReal(vec2 p) {
  if (uAurora < 0.001) return vec3(0.);
  float lens = auroraLens();
  float ux = (p.x - 0.5 * uCss.x) / lens - (uCss.x < 900. ? 0.12 : 0.);
  // There the disc also fills most of the width, so the ribbon is lifted to stand on the moon's upper limb,
  // as long as enough sky remains above it.
  float lift = uCss.x < 900. ? min((uHorizon - uMoon.y + uMoon.z) / lens - 0.04, max(uHorizon / lens - 0.35, 0.)) : 0.;
  float uy = (uHorizon - p.y) / lens - lift;
  if (uy < 0.004 || uy > 2.6) return vec3(0.);
  // A wide fade toward the horizon replaces any hard edge.
  vec3 aurora = auroraSheet(0, ux, uy) * smoothstep(0.004, 0.05, uy);
  aurora += 0.12 * auroraSheet(1, ux, uy);
  // The ribbon thins out in front of the moon so the disc stays the hero.
  float m = length(p - uMoon.xy) / uMoon.z;
  float spare = 0.12 + 0.88 * smoothstep(0.95, 1.8, m);
  return aurora * 0.7 * spare * uAurora;
}

/** A coarse map at a CSS position; maps cover the screen width from the top down to the horizon. */
vec3 mapAt(sampler2D map, vec2 span, vec2 p, float lod) {
  return textureLod(map, vec2(p.x / span.x, 1. - p.y / span.y), lod).rgb;
}

/** Soft-focus aurora light: three taps of the aurora map spread over the screen blur it into a diffuse glow. */
vec3 auroraLight(vec2 p) {
  if (uAurora < 0.001) return vec3(0.);
  vec2 o = vec2(1., -0.4) * AURORA_BLUR * auroraLens();
  return 0.4 * mapAt(uAuroraTex, uAuroraSpan, p, 0.) + 0.3 * mapAt(uAuroraTex, uAuroraSpan, p + o, 0.)
    + 0.3 * mapAt(uAuroraTex, uAuroraSpan, p + vec2(-o.x, o.y), 0.);
}

/** The aurora light the last skyReal call added; the glyph level must not count it. */
vec3 gSkyAurora = vec3(0.);

vec3 skyReal(vec2 p, float footprint, bool withStars) {
  float H = uCss.y;
  float R = uMoon.z;
  float dist = length(p - uMoon.xy);
  float cover = clamp((R - dist) / footprint + 0.5, 0., 1.);
  vec3 col = vec3(0.);
  // The sky behind the opaque disc is never seen.
  if (cover < 1.) {
    float h = clamp((uHorizon - p.y) / uHorizon, 0., 1.);
    col = mix(vec3(0.013, 0.024, 0.036), vec3(0.0018, 0.0038, 0.0115), pow(h, 0.42));
    col += vec3(0.016, 0.026, 0.032) * exp(-(uHorizon - p.y) / (H * 0.05));

    float o = max(dist - R, 0.) / R;
    float halo = 0.5 * exp(-o / 0.022) + 0.09 * exp(-o / 0.1) + 0.05 * exp(-o / 0.3) + 0.016 * exp(-o / 0.8);
    col += vec3(0.72, 0.84, 1.0) * halo * 1.15;

    float dim = 1. - smoothstep(0.02, 0.2, halo);
    if (uAurora < 1.) {
      float a = auroraAt(p) * dim;
      vec3 auroraCol = mix(vec3(0.16, 1.0, 0.48), vec3(0.12, 0.62, 0.8), smoothstep(0.1, 0.9, p.y / uHorizon));
      col += auroraCol * a * 0.12 * gAurora * (1. - uAurora);
    }
    if (withStars) {
      float haze = exp(-(uHorizon - p.y) / (H * 0.08));
      col += (stars(p) + dust(p)) * dim * (1. - 0.85 * haze) * (p.y < uHorizon ? 1. : 0.);
    }
  }
  if (cover > 0.) {
    vec3 m = moonReal(p, footprint);
    float strat = fbm(vec2(p.x * 0.0035 + uTime * 0.004, p.y * 0.05));
    float veil = clamp(exp(-(uHorizon - p.y) / (H * 0.11)) * (0.3 + 1.0 * strat), 0., 0.85);
    m = mix(m, vec3(0.30, 0.31, 0.34), veil * 0.62);
    col = mix(col, m, cover);
  }
  // Emission only adds light, so the moon stays readable under it.
  gSkyAurora = auroraLight(p) * gAuroraNew * mix(1., 0.55, cover);
  return col + gSkyAurora;
}

// ---------------------------------------------------------------- real sea
vec3 curtainReflection(vec2 p, float d, float tilt) {
  float dpx = p.y - uHorizon;
  float sy = uHorizon - dpx * 1.5;
  if (sy < 0.) return vec3(0.);
  float wob = sin(p.y * 0.1375 + uTime * 1.3 + sin(p.y * 0.0425 + uTime * 0.4) * 2.);
  float x = p.x + wob * (0.8 + 3.2 * d) * NOMINAL_PIXEL + tilt;
  vec2 uv = vec2(x / uCurtainView.x, 1. - sy / uCurtainView.y);
  vec3 c = texture(uCurtain, uv).rgb;
  float adx = abs(p.x - uCss.x * 0.5) / uCss.x;
  float lens = 1. + 0.4 * (1. - smoothstep(0.27, 0.33, adx)) + 0.4 * (1. - smoothstep(0.18, 0.24, adx)) + 0.4 * (1. - smoothstep(0.12, 0.16, adx));
  float base = 0.5 * smoothstep(0., 0.12, d) * (1. - 0.45 * d);
  return c * base * lens;
}

// ---------------------------------------------------------------- spectral ocean (see ocean.ts)
/** Adds one FFT cascade: height, slopes and (scaled) choppiness derivatives, mip-mapped to the footprint. */
void cascade(sampler2D ta, sampler2D tb, vec2 P, float tile, float texel, float lam, float off, float fp,
             inout float h, inout vec2 S, inout vec3 D) {
  vec2 uv = P / tile + vec2(0.37, 0.21) * off;
  float lod = log2(max(fp / texel, 1.));
  vec4 a = textureLod(ta, uv, lod);
  vec4 b = textureLod(tb, uv, lod);
  h += a.x;
  S += vec2(a.y, a.z);
  D += lam * vec3(a.w, b.x, b.y);
}

/**
 * Sea state at world position P (metres, x right, z away): height, slope, Jacobian of the
 * choppy displacement, and the slope variance of waves too fine for a footprint of fp metres.
 */
void oceanField(vec2 P, float fp, out float h, out vec2 S, out float jac, out float lostVar) {
  h = 0.;
  S = vec2(0.);
  vec3 D = vec3(0.);
  cascade(uSeaA0, uSeaB0, P, uSeaTile.x, uSeaTexel.x, uSeaLam.x, 0., fp, h, S, D);
  cascade(uSeaA1, uSeaB1, P, uSeaTile.y, uSeaTexel.y, uSeaLam.y, 1., fp, h, S, D);
  if (uSeaTile.z > 0.) cascade(uSeaA2, uSeaB2, P, uSeaTile.z, uSeaTexel.z, uSeaLam.z, 2., fp, h, S, D);
  jac = (1. + D.x) * (1. + D.y) - D.z * D.z;
  // Choppy waves are steeper where the surface is squeezed together.
  S /= max(0.45, 1. + D.x + D.y);
  float pos = (log2(PI / fp) + 6.) / 13. * 31.;
  float i0 = clamp(floor(pos), 0., 31.);
  float i1 = min(i0 + 1., 31.);
  lostVar = mix(uLost[int(i0)], uLost[int(i1)], clamp(pos - i0, 0., 1.)) * (pos < 31. ? 1. : 0.);
}

vec3 seaReal(vec2 p) {
  float W = uCss.x;
  float H = uCss.y;
  float cx = 0.5 * W;
  float dpx = max(p.y - uHorizon, 0.5);
  float d = clamp(dpx / (H - uHorizon), 0., 1.);
  float z = 1. / (0.04 + 0.96 * d);
  float f = W;
  vec3 D = normalize(vec3((p.x - cx) / f, -dpx / f, 1.));

  float eta;
  vec2 g;
  vec3 n;
  float lostVar;
  float calmFar = 1.;
  float tiltPx;
  float foam = 0.;
  float wx;
  float v;
  if (uFft > 0.5) {
    // Real-world scale: the camera sits uSeaHeight metres above the water and looks at the horizon.
    float Z = min(uSeaHeight * f / dpx, 30000.);
    float X = (p.x - cx) / f * Z;
    float fpx = Z / f * uPix;
    float fpz = Z * Z / (uSeaHeight * f) * uPix;
    // Crests run across the view, so z-detail aliases first: lean toward the long footprint axis.
    float fp = max(sqrt(fpx * fpz), 0.6 * fpz);
    float h;
    vec2 S;
    float jac;
    oceanField(vec2(X, Z), fp, h, S, jac, lostVar);
    eta = h / 0.4;
    g = S * 6.;
    n = normalize(vec3(-S.x, 1., -S.y));
    tiltPx = -S.x * 80.;
    wx = X * 0.4;
    v = Z * 0.3;
    foam = smoothstep(0.5, 0.1, jac) * (1. - smoothstep(0.03, 0.4, fp));
  } else {
    v = z * 12.;
    float fp = max(12. * 0.96 * z * z * uPix / (H - uHorizon), 12. * z * uPix / W);
    wx = (p.x - cx) / W * 12. * z + 0.6 * sin(v * 0.45 + uTime * 0.3 + (p.x - cx) * 0.005);
    waveField(vec2(wx, v), uTime, fp, 13, eta, g);
    calmFar = 0.55 + 0.45 * smoothstep(0.0, 0.5, d);
    n = normalize(vec3(-g.x * 0.13 * calmFar, 1., -g.y * 0.13 * calmFar));
    lostVar = 0.9 * waveLost * 0.13 * 0.13 * calmFar * calmFar;
    tiltPx = -g.x * 0.13 * calmFar * 90.;
  }

  float cosv = clamp(dot(n, -D), 0., 1.);
  float fres = 0.02 + 0.98 * pow(1. - cosv, 5.);
  vec3 R = reflect(D, n);
  R.y = max(R.y, 0.002);
  float rz = max(R.z, 0.1);
  vec2 rp = vec2(cx + f * R.x / rz, uHorizon - 1.5 * f * R.y / rz);
  // The moon's reflection is broken by the swell: the blur grows toward the viewer,
  // so the reflection becomes a wide soft glitter path instead of a mirrored disc.
  float spread = 16. + 220. * d + 80. * length(g) * calmFar;
  float footprint = uPix + spread * 0.8;
  vec3 refl = vec3(0.);
  float wsum = 0.;
  // The sky map is coarse already; its mip level widens the blur further with the footprint.
  float lod = log2(max(footprint / uSkyTexel, 1.));
  for (int i = -2; i <= 2; i++) {
    float fi = float(i);
    float w = exp(-fi * fi * 0.35);
    vec2 at = rp + vec2(fi * spread * 0.55, fi * fi * spread * 0.06);
    refl += w * mapAt(uSkyTex, uSkySpan, at, lod);
    wsum += w;
  }
  refl /= wsum;

  float lit = exp(-pow((p.x - uMoon.x) / (uMoon.z * (0.7 + 0.6 * d)), 2.)) * (1. - 0.45 * d);
  vec3 deep = vec3(0.0035, 0.0095, 0.0150);
  vec3 col = deep * (1. + 2. * lit) + vec3(0.010, 0.026, 0.034) * lit * (0.35 + 0.65 * clamp(0.5 + 0.5 * eta, 0., 1.));
  col += refl * fres * (0.06 + 0.8 * exp(-pow((p.x - uMoon.x) / (uMoon.z * (1.0 + 0.6 * d)), 2.)));

  // Wide luminous path under the moon; the sides stay dark with only a faint sheen.
  float dx = p.x - uMoon.x;
  float pathW = exp(-pow(dx / (uMoon.z * (0.95 + 0.7 * d)), 2.));
  float sheen = exp(-pow(dx / (uMoon.z * (0.5 + 0.8 * d)), 2.)) * (1. - 0.3 * d);
  col += vec3(0.50, 0.66, 0.86) * 0.012 * sheen * (0.5 + 0.5 * clamp(0.5 + 0.6 * eta, 0., 1.)) * smoothstep(0., 0.06, d);
  float broken = smoothstep(-0.1, 0.9, 0.7 * eta + 0.5 * g.y + 1.4 * (fbm(vec2(wx * 1.8, v * 1.3 + uTime * 0.25)) - 0.4));
  col += vec3(0.62, 0.74, 0.95) * pathW * broken * 0.22 * (1. - 0.3 * d) * smoothstep(0., 0.03, d);

  // Moonlight broken by the waves: GGX highlights of the moon on the real surface normal.
  // Ripples too small for this pixel are folded into the roughness, so far water turns into
  // a smooth bright band and near water shows irregular silver crests that move with the swell.
  // The moon is an area light: inside its disc the light direction follows the pixel, so the
  // highlights span the whole disc width instead of a thin beam; outside it falls off smoothly.
  float moonRad = uMoon.z / f * 0.85;
  vec3 Lm = normalize(vec3(moonRad * tanh(D.x / D.z / moonRad), (uHorizon - uMoon.y) / f, 1.));
  vec3 Hh = normalize(Lm - D);
  float nh = max(dot(n, Hh), 0.);
  float a2 = 0.022 + lostVar;
  float den = nh * nh * (a2 - 1.) + 1.;
  float ggx = a2 / (PI * den * den);
  float pl = uPointer.z * exp(-pow(length(vec2(p.x - uPointer.x, (p.y - uPointer.y) * 1.6)) / 110., 2.));
  // A wide lobe lights every crest and slope that faces the huge moon, across the whole sea.
  float a2w = 0.035 + 2. * lostVar;
  float denW = nh * nh * (a2w - 1.) + 1.;
  float ggxW = a2w / (PI * denW * denW);
  float wideEnv = exp(-pow(dx / (uMoon.z * (1.7 + 0.8 * d)), 2.)) * (1. - 0.35 * d);
  col += vec3(0.70, 0.82, 1.0) * ggxW * (0.05 + fres * 1.5) * 0.18 * wideEnv * smoothstep(0., 0.03, d);
  // Soft wide band right under the moon, about as wide as the disc, broken up by the swell.
  float band = exp(-pow(dx / (uMoon.z * 0.95), 4.)) * exp(-d * 5.);
  col += vec3(0.66, 0.78, 0.98) * band * (0.25 + 0.75 * broken) * 0.25 * smoothstep(0., 0.02, d);
  col += vec3(0.80, 0.90, 1.0) * ggx * (0.05 + fres * 1.5) * 0.06 * (1. + 1.5 * pl) * smoothstep(0., 0.03, d);

  col += curtainReflection(p, d, tiltPx) * 0.5;
  col += vec3(0.55, 0.62, 0.72) * foam * 0.03 * (0.3 + 2. * pathW);

  // Moonlit fog on the water where it meets the horizon.
  float fog = exp(-d * 9.);
  col = mix(col, vec3(0.03, 0.045, 0.058) * (0.5 + 1.2 * exp(-pow((p.x - uMoon.x) / (uMoon.z * 1.0), 2.))), fog * 0.5);
  col += vec3(0.5, 0.62, 0.75) * 0.1 * exp(-d * 7.) * exp(-pow((p.x - uMoon.x) / (uMoon.z * 0.95), 2.));
  return col;
}

vec3 tonemap(vec3 x) {
  x *= 0.95;
  vec3 c = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  c = clamp(c, 0., 1.);
  return pow(c, vec3(1. / 2.2));
}

// ---------------------------------------------------------------- 1997: the same scene as palette ramps
vec3 inkLerp(float v) {
  float s = clamp(v, 0., 1.) * 7.;
  int i = int(floor(s));
  return mix(INK[i], INK[min(i + 1, 7)], s - floor(s));
}
vec3 moonLerp(float v) {
  float s = clamp(v, 0., 1.) * 8.;
  int i = int(floor(s));
  return mix(MOON_INK[i], MOON_INK[min(i + 1, 8)], s - floor(s));
}
vec3 glowLerp(float v) {
  float s = clamp(v, 0., 1.) * 4.;
  int i = int(floor(s));
  return mix(GLOW[i], GLOW[min(i + 1, 4)], s - floor(s));
}

/** Stars on the pixel grid: one blinking star pixel, a cross for the bright ones, meteor as a dithered streak. */
vec3 pixelStars(vec2 pc, vec3 col, float t, bool fine) {
  float H = uCss.y;
  float hy = uHorizon;
  vec2 pcat = toCatalogue(pc);
  vec2 cell = floor(pcat / STAR_CELL);
  float reach = 2. * uPix + 1.;
  vec2 f = (pcat / STAR_CELL - cell) * STAR_CELL;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx < 0 && f.x > reach) continue;
      if (dx > 0 && STAR_CELL - f.x > reach) continue;
      if (dy < 0 && f.y > reach) continue;
      if (dy > 0 && STAR_CELL - f.y > reach) continue;
      Star s = starOf(cell + vec2(float(dx), float(dy)));
      vec2 sp = fromCatalogue(s.pos);
      if (haloLevel(sp) > 0.1 || sp.y > hy * 0.95) continue;
      float low;
      float chroma;
      // Pixel blink: the noise swings the level across two or three ramp steps.
      float l = s.level * (1. + (scintillation(s, sp, low, chroma) - 1.) * 1.6);
      l *= (1. - 0.8 * exp(-(hy - sp.y) / (H * 0.08))) * starVisibility(sp);
      float near = length(sp - uPointer.xy) / (22. * NOMINAL_PIXEL);
      l += uPointer.z * 0.7 * exp(-near * near);
      ivec2 d = abs(ivec2(floor(pcat / uPix)) - ivec2(floor(s.pos / uPix)));
      bool arm = (s.cross > 0.5 || l > 0.9) && (d.x + d.y == 1);
      if (d.x == 0 && d.y == 0) col = fine ? inkLerp(l) : INK[int(floor(clamp(l, 0., 1.) * 7. + 0.5))];
      else if (arm) col = fine ? inkLerp(l * 0.45) : INK[int(floor(clamp(l * 0.45, 0., 1.) * 7. + 0.5))];
    }
  }
  float m = meteorAt(pc) * 0.85;
  if (m > 0.12) col = max(col, fine ? inkLerp(m) : shadeInk(m, t));
  return col;
}

/** The 1997 moon at pc: the photo texture stretched onto the dithered moon palette; returns its level. */
float moon1997(vec2 pc, float t, out vec3 col) {
  vec2 md = pc - uMoon.xy;
  float r = length(md) / uMoon.z;
  vec3 tex = moonTexel(md / uMoon.z, moonLod(uPix));
  float n = clamp((moonLuma(tex) - 0.19) / (0.96 - 0.19), 0., 1.);
  float stretched = clamp((n - 0.08) / 0.7, 0., 1.);
  float value = (0.34 + 0.66 * pow(stretched, 0.75)) * (1. - 0.1 * r * r * r);
  col = shadeMoon(value, t);
  return value;
}

void shade1997(vec2 pc, ivec2 cell, out vec3 col, out float level) {
  float W = uCss.x;
  float H = uCss.y;
  float hy = uHorizon;
  float R = uMoon.z;
  float t = bayer(cell);
  level = 0.;

  if (abs(pc.y - hy) <= 0.5 * uPix) {
    float axis = exp(-pow((pc.x - uMoon.x) / R, 2.));
    col = shadeInk(0.3 + 0.12 * hashCell(cell) + 0.55 * axis, t);
    return;
  }

  if (pc.y < hy) {
    float value = haloLevel(pc);
    vec2 md = pc - uMoon.xy;
    float dist = length(md);
    bool onMoon = dist <= R;
    float idx = 0.;
    if (onMoon) {
      value = moon1997(pc, t, col);
    } else {
      idx = rampIndex(value, 7., t);
      col = INK[int(idx)];
    }
    level = value;

    if (!onMoon && idx < 0.5 && pc.y < hy * 0.96) {
      float g = auroraAt(pc);
      if (g > 0.04) col = shadeGlow(g, t);
    }

    col = pixelStars(pc, col, t, false);
    return;
  }

  // Sea: the same swell as the 2026 water, with the 1997 lighting model.
  float depth = H - hy;
  float cx = 0.5 * W;
  float d = (pc.y - hy) / depth;
  float z = 1. / (0.06 + 0.94 * d);
  float v = z * 12.;
  float far = smoothstep(0.1, 0.42, d);
  float glitterWidth = R * (0.2 + 0.2 * d);
  float lightSpread = R * (0.7 + 0.6 * d);
  float lightFall = 1. - 0.45 * d;
  float warpScale = 1. + 15. * d;
  float wx = (pc.x - cx) / W * 12. * z + 0.6 * sin(v * 0.45 + uTime * 0.3 + (pc.x - cx) * 0.005);
  float eta;
  vec2 g;
  waveField(vec2(wx, v), uTime, 0., 3, eta, g);
  float slope = g.y;

  float lit = exp(-pow((pc.x - uMoon.x) / lightSpread, 2.)) * lightFall;
  float value = 0.06 + 0.4 * smoothstep(-0.3, 1.0, slope) * far * (1. + 1.1 * lit) + 0.14 * far * lit;
  float q = (pc.x - uMoon.x + eta * warpScale * 0.8 * NOMINAL_PIXEL) / glitterWidth;
  if (q > -3. && q < 3.) {
    float sparkle = smoothstep(0., 0.6, slope * 0.6 + eta * 0.55);
    value += exp(-q * q) * sparkle * (0.35 + 0.65 * smoothstep(0., 0.1, d)) * (1. - 0.3 * d) * 1.4;
  }
  float crest = smoothstep(0.66, 0.98, eta);
  if (crest > 0. && hashCell(cell) > 0.5) value += crest * far * 0.5;
  value += 0.3 * exp(-d * 14.) + 0.95 * exp(-d * 7.) * exp(-pow((pc.x - uMoon.x) / (R * 0.95), 2.));
  float near = length(vec2(pc.x - uPointer.x, (pc.y - uPointer.y) * 1.6)) / NOMINAL_PIXEL;
  if (near < 30.) value += uPointer.z * 0.45 * exp(-pow(near / 12., 2.)) * (0.4 + 0.6 * far);
  col = shadeInk(value, t);
  col += curtainReflection(pc, d, 0.) * 1.0;
}

/** Physically shaded scene in linear HDR: sky or sea, with haze straddling the horizon. */
vec3 realHdr(vec2 pc, bool withStars) {
  vec3 hdr = pc.y < uHorizon ? skyReal(pc, uPix, withStars) : seaReal(pc);
  float hb = exp(-abs(pc.y - uHorizon) / (uCss.y * 0.034));
  vec3 hz = vec3(0.045, 0.065, 0.085) + vec3(0.30, 0.34, 0.40) * exp(-pow((pc.x - uMoon.x) / (uMoon.z * 1.05), 2.));
  return mix(hdr, hz, hb * 0.75);
}

/**
 * The realistic scene pushed through the 1997 ramps: its per-layer luminance picks entries of
 * the sky / moon palettes, so forms change but colours stay teal-grey. With fine = true the ramps
 * are interpolated and quantised to uLevels shades instead of the hand-made steps.
 */
void shadeRamp(vec2 pc, ivec2 cell, bool fine, out vec3 col, out float level) {
  float H = uCss.y;
  float hy = uHorizon;
  float t = bayer(cell);
  gAuroraNew = 0.;
  vec3 hdr = realHdr(pc, false);
  gAuroraNew = 1.;
  bool sky = pc.y < hy;
  bool onMoon = sky && length(pc - uMoon.xy) <= uMoon.z;
  float l = dot(tonemap(hdr), vec3(0.2126, 0.7152, 0.0722));
  float lvl = onMoon ? clamp((l - 0.14) / 0.78, 0., 1.) : clamp(pow(l, 0.8) * 1.05 - 0.03, 0., 1.);
  level = sky ? lvl : 0.;
  float lq = lvl;
  float idx = 0.;
  if (fine) {
    lq = clamp(floor(lvl * uLevels + 0.5 + (t - 0.5) * uDither) / uLevels, 0., 1.);
    col = onMoon ? moonLerp(lq) : inkLerp(lq);
  } else if (onMoon) {
    col = shadeMoon(lvl, t);
  } else {
    idx = rampIndex(lvl, 7., t);
    col = INK[int(idx)];
  }
  if (!sky) return;
  if (!onMoon && (fine ? lq < 0.03 : idx < 0.5) && pc.y < hy * 0.96) {
    float g = auroraAt(pc);
    if (g > 0.04) col = fine ? glowLerp(g) : shadeGlow(g, t);
  }
  if (!onMoon && uAurora > 0.) {
    float a = clamp(dot(auroraLight(pc), vec3(0.2126, 0.7152, 0.0722)) * 6., 0., 1.);
    if (a > 0.03) {
      vec3 gc = fine ? glowLerp(a) : shadeGlow(a, t);
      if (gc.g > col.g) col = gc;
    }
  }
  col = pixelStars(pc, col, t, fine);
}

vec3 quantise(vec3 c, ivec2 cell) {
  if (uLevels < 1.5) return c;
  float t = bayer(cell);
  vec3 q = floor(c * (uLevels - 1.) + 0.5 + (t - 0.5) * uDither);
  return clamp(q / (uLevels - 1.), 0., 1.);
}

void main() {
  vec2 pc = vec2(gl_FragCoord.x, uTexSize.y - gl_FragCoord.y) * uPix;
#if PASS == 1
  outColor = vec4(auroraReal(pc), 1.);
#elif PASS == 2
  // The sky the sea reflects; the ramp stages keep the new aurora out of it, as in shadeRamp.
  gAuroraNew = uMode == 3 ? 1. : 0.;
  outColor = vec4(skyReal(pc, uPix, false), 1.);
#elif PASS == 3
  ivec2 cell = ivec2(int(gl_FragCoord.x), int(uTexSize.y) - 1 - int(gl_FragCoord.y));
  vec3 col;
  float level;
  shade1997(pc, cell, col, level);
  outColor = vec4(clamp(col, 0., 1.), level);
#else
  ivec2 cell = ivec2(int(gl_FragCoord.x), int(uTexSize.y) - 1 - int(gl_FragCoord.y));
  vec3 col;
  float level;
  if (uMode == 0) {
    shade1997(pc, cell, col, level);
    col = clamp(col, 0., 1.);
  } else if (uMode <= 2) {
    // 1: realistic forms dissolve in through the 1997 picture (ordered mask); 2: fully realistic forms.
    bool fine = uMode == 2;
    bool real = fine || uMix >= 1. || bayer(ivec2(cell.y, cell.x) + ivec2(1, 2)) < uMix;
    if (real) shadeRamp(pc, cell, fine, col, level);
    else shade1997(pc, cell, col, level);
    col = clamp(col, 0., 1.);
  } else {
    vec3 hdr = realHdr(pc, true);
    col = tonemap(hdr);
    // The glyph pass reads this level to tell the lit moon from the sky; aurora light must not count.
    vec3 withoutAurora = hdr - gSkyAurora;
    level = pc.y < uHorizon ? clamp(dot(tonemap(max(withoutAurora, 0.)), vec3(0.2126, 0.7152, 0.0722)) * 1.1, 0., 1.) : 0.;
    col = quantise(col, cell);
  }
  outColor = vec4(col, level);
#endif
}`;

/**
 * Scene shader for one pass: 0 the scene itself, 1 the aurora map, 2 the sky map the sea reflects,
 * 3 the 1997 picture alone (small, so it compiles fast and shows while the others still compile).
 */
export function sceneFs(pass: 0 | 1 | 2 | 3): string {
  return SCENE_FS.replace('#version 300 es', `#version 300 es\n#define PASS ${pass}`);
}

// ------------------------------------------------------------------ curtain glyphs
export const GLYPH_UNIFORMS = [
  'uView', 'uQuad', 'uPad', 'uSlots', 'uRows', 'uAtlas', 'uScene', 'uSceneMap', 'uCanvas', 'uDpr',
  'uMode', 'uGlow', 'uShift', 'uLit',
] as const;

export const GLYPH_VS = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPos;
in vec3 aData;
uniform vec2 uView;
uniform vec2 uQuad;
uniform vec2 uPad;
uniform float uSlots;
uniform float uShift;
out vec2 vUv;
out float vAlpha;
out float vTint;

void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 css = aPos - uPad + corner * (uQuad + 2. * uPad);
  css.x += uShift;
  gl_Position = vec4(css.x / uView.x * 2. - 1., 1. - css.y / uView.y * 2., 0., 1.);
  vUv = vec2((aData.x + corner.x) / uSlots, corner.y);
  vAlpha = aData.y;
  vTint = aData.z;
}`;

export const GLYPH_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in float vAlpha;
in float vTint;
out vec4 outColor;
uniform sampler2D uAtlas;
uniform sampler2D uScene;
uniform vec4 uSceneMap;
uniform vec2 uCanvas;
uniform float uDpr;
uniform float uRows;
uniform int uMode;
uniform float uGlow;
uniform float uLit;

const vec3 WHITE = vec3(0.875, 0.91, 0.90);
const vec3 ACCENT = vec3(0.631, 0.792, 0.945);
const vec3 DARK = vec3(0.012, 0.024, 0.04);

void main() {
  float crisp = texture(uAtlas, vec2(vUv.x, vUv.y / uRows)).a;
  float glow = uGlow > 0.5 ? texture(uAtlas, vec2(vUv.x, (1. + vUv.y) / uRows)).a : 0.;
  vec3 tint = mix(WHITE, ACCENT, vTint);
  float cov = crisp * vAlpha;
  float soft = glow * vAlpha * uGlow;

  if (uMode == 1) {
    // Reflection map: plain light, summed additively.
    outColor = vec4(tint * (cov + soft * 0.6), 1.);
    return;
  }

  vec2 css = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) / uDpr;
  float level = texture(uScene, vec2(css.x / uSceneMap.x, 1. - css.y / uSceneMap.y)).a;
  float dark = smoothstep(0.36, 0.56, level);
  float light = 1. - smoothstep(0.3, 0.5, level);
  // Over the lit moon the cloth turns into dark lace, elsewhere it glows.
  float darkA = min(0.95, cov * 1.15 + 0.12 * min(1., cov * 3.)) * dark;
  float lightA = min(1., cov + soft * 0.55) * light;
  if (uLit > 0.5) {
    // Latent words: visible only where the aurora lights them, in the aurora's own hue.
    vec3 sc = texture(uScene, vec2(css.x / uSceneMap.x, 1. - css.y / uSceneMap.y)).rgb;
    float peak = max(sc.r, max(sc.g, sc.b));
    tint = mix(vec3(0.85, 1.0, 0.9), sc / max(peak, 0.02), 0.5);
    lightA *= smoothstep(0.16, 0.45, peak);
  }
  vec3 lightRgb = tint * lightA;
  outColor = vec4(DARK * darkA * (1. - lightA) + lightRgb, lightA + darkA * (1. - lightA));
}`;

// ------------------------------------------------------------------ composite (CRT stage + grain)
export const COMPOSITE_UNIFORMS = [
  'uScene', 'uCanvas', 'uDpr', 'uPix', 'uTexSize', 'uFlick', 'uScan', 'uGrain', 'uVignette', 'uTime', 'uShift', 'uHorizon', 'uCurve',
  'uFringe',
] as const;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uScene;
uniform vec2 uCanvas;
uniform float uDpr;
uniform float uPix;
uniform vec2 uTexSize;
uniform float uFlick;
uniform float uScan;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform float uShift;
uniform float uHorizon;
uniform float uCurve;
/** Lens colour fringes at the frame corners, CSS px. */
uniform float uFringe;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 fetch(vec2 css) {
  return texture(uScene, vec2(css.x / (uPix * uTexSize.x), 1. - css.y / (uPix * uTexSize.y))).rgb;
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) / uDpr;
  float tick = floor(uTime * 24.);
  float band = floor(css.y / 7.);
  float r = hash(vec2(band, tick));
  float jitter = (r > 0.78 ? (r - 0.78) * 90. : 0.) * uFlick * (hash(vec2(band, tick + 5.)) - 0.5) * 2.;
  vec2 at = vec2(css.x + jitter - uShift, css.y);
  // Earth curvature, faked: columns sink toward the screen edges by up to uCurve CSS px, so the
  // horizon becomes an arch. The top edge stays put and the shift grows down to the horizon, then
  // holds over the sea; verticals stay vertical, unlike a lens distortion.
  float u = css.x / (uCanvas.x / uDpr) * 2. - 1.;
  at.y -= uCurve * u * u * min(css.y / uHorizon, 1.);
  vec3 col;
  if (uFlick > 0.01 || uFringe > 0.01) {
    // Glitch bursts split the channels sideways; the lens fringes grow toward the corners.
    vec2 mid = uCanvas / uDpr * 0.5;
    vec2 e = (at - mid) / length(mid);
    vec2 split = vec2(3.0 * uFlick, 0.) + e * dot(e, e) * uFringe;
    col = vec3(fetch(at + split).r, fetch(at).g, fetch(at - split).b);
  } else {
    col = fetch(at);
  }
  float row = fract(css.y / uPix);
  col *= 1. - uScan * smoothstep(0.5, 1.0, row);
  col *= 1. + uFlick * 0.12 * (hash(vec2(tick, 1.)) - 0.3);
  vec2 q = css / (uCanvas / uDpr) - 0.5;
  col *= 1. - uVignette * dot(q, q) * 1.6;
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.) - 0.5) * uGrain;
  outColor = vec4(col, 1.);
}`;
