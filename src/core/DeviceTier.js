// Device-tier heuristic → quality preset. Runs once on first load; the user
// can always override from Settings. The heuristic errs toward the tier below
// when unsure: a smooth 60 fps at Medium beats a stuttering High.

export function detectDeviceTier() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || navigator.maxTouchPoints > 2;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || (isMobile ? 4 : 8);
  const dpr = window.devicePixelRatio || 1;

  let gpu = '';
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* ignore */
  }
  const g = gpu.toLowerCase();

  let score = 0;
  if (/rtx|radeon rx|apple m[1-9]|arc a|geforce gtx 16|gtx 10[6-8]/.test(g)) score += 3;
  else if (/geforce|radeon|apple gpu|adreno 7|mali-g7[0-9]{2}|xe graphics/.test(g)) score += 2;
  else if (/intel|iris|uhd|adreno|mali|swiftshader|llvmpipe/.test(g)) score += 1;
  else score += 2; // unknown desktop-class GPU

  if (cores >= 8) score += 1;
  if (mem >= 8) score += 1;
  if (isMobile) score -= 2;
  if (dpr >= 3 && isMobile) score -= 1;
  if (/swiftshader|llvmpipe/.test(g)) score = 0;

  let tier;
  if (score >= 5) tier = 'ultra';
  else if (score >= 4) tier = 'high';
  else if (score >= 2) tier = 'medium';
  else tier = 'low';

  return { tier, gpu, isMobile, cores, mem, dpr, hasWebGPU: !!navigator.gpu };
}
