/** Small WebGL2 helpers: programs, uniform lookup and render targets. */

function startShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Cannot create a shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export interface Program<U extends string> {
  program: WebGLProgram;
  u: Record<U, WebGLUniformLocation | null>;
}

interface PendingProgram {
  program: WebGLProgram;
  shaders: readonly [WebGLShader, WebGLShader];
}

/** Issues compile and link without asking for the result, so the driver may still be working on it. */
function startProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  attributes: Readonly<Record<string, number>>,
): PendingProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Cannot create a program');
  const shaders = [startShader(gl, gl.VERTEX_SHADER, vertex), startShader(gl, gl.FRAGMENT_SHADER, fragment)] as const;
  for (const shader of shaders) gl.attachShader(program, shader);
  for (const [name, location] of Object.entries(attributes)) gl.bindAttribLocation(program, location, name);
  gl.linkProgram(program);
  return { program, shaders };
}

/** Reads the compile and link status (this blocks until the driver is done) and looks up uniforms. */
function finishProgram<U extends string>(gl: WebGL2RenderingContext, pending: PendingProgram, uniforms: readonly U[]): Program<U> {
  const { program, shaders } = pending;
  try {
    for (const shader of shaders) {
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader) ?? ''}`);
    }
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? ''}`);
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
  const u = {} as Record<U, WebGLUniformLocation | null>;
  for (const name of uniforms) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

/**
 * Compiles and links a program. With KHR_parallel_shader_compile it waits for the driver frame by
 * frame instead of blocking the page; without it the compile blocks. Big shaders can take Direct3D
 * (ANGLE, Windows) tens of seconds. Programs started together compile in parallel.
 */
export async function createProgramAsync<U extends string>(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  uniforms: readonly U[],
  attributes: Readonly<Record<string, number>> = {},
): Promise<Program<U>> {
  const pending = startProgram(gl, vertex, fragment, attributes);
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  if (parallel) {
    while (!gl.isContextLost() && !gl.getProgramParameter(pending.program, parallel.COMPLETION_STATUS_KHR)) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  return finishProgram(gl, pending, uniforms);
}

export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export function createTexture(gl: WebGL2RenderingContext, min: number, mag: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Cannot create a texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export function createTarget(gl: WebGL2RenderingContext, width: number, height: number, nearest: boolean): Target {
  const filter = nearest ? gl.NEAREST : gl.LINEAR;
  const texture = createTexture(gl, filter, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('Cannot create a framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer is incomplete');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, width, height };
}

/**
 * Linear light map. hdr = RGBA16F, which needs EXT_color_buffer_float or EXT_color_buffer_half_float;
 * otherwise RGBA8, which clips light above 1.
 */
export function createLightTarget(gl: WebGL2RenderingContext, width: number, height: number, mipmaps: boolean, hdr: boolean): Target {
  const texture = createTexture(gl, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR, gl.LINEAR);
  if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('Cannot create a framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error('Framebuffer is incomplete');
  }
  return { texture, framebuffer, width, height };
}

export function deleteTarget(gl: WebGL2RenderingContext, target: Target | null): void {
  if (!target) return;
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

export function bindTexture(gl: WebGL2RenderingContext, unit: number, texture: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}
