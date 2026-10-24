const NEGATIVE = 'No neon, no glow, no text, no letters, no numbers, no captions, no logos, no watermarks, no collages, no multiple panels, no people, no hands.';

const TONES = [
  { id: 'natural', title: 'Natural neutral', prompt: 'Use warm ivory, stone, sand, taupe and restrained sage accents. Keep the background light but visibly warm, not pure white.', colors: ['#eee5d8', '#c7b49a', '#8e7b68', '#7b8764'] },
  { id: 'blue-violet', title: 'Blue & violet', prompt: 'Use a muted blue-violet palette: navy, indigo, dusty violet and soft blue-gray, with a pale blue-gray background.', colors: ['#26395d', '#55588e', '#8c7fa6', '#ccd5df'] },
  { id: 'warm-earth', title: 'Warm earth', prompt: 'Use a warm earthy palette: terracotta, muted ochre, clay, sand and olive, with a warm cream background.', colors: ['#a94f35', '#c58a3d', '#d8b58d', '#6e744b'] },
  { id: 'fresh-muted', title: 'Fresh muted', prompt: 'Use a fresh but muted palette: sage green, muted teal, dusty coral and pale sky blue, with a softly tinted background.', colors: ['#819d78', '#4f8584', '#c47d70', '#b9ced8'] }
];

const make = (id, title, prompt) => ({ id, title, prompt: `${prompt}\n${NEGATIVE}`, tones: structuredClone(TONES), image: { kind: 'builtin', file: `${id}.png` }, builtin: true, updatedAt: 1 });

export const BUILTIN_TEMPLATES = [
  make('minimal-product', 'Clean Minimalist Product', 'Minimalist product illustration with soft volume, gentle shading and clear geometric shapes. Matte surfaces, natural muted color palette, soft diffused lighting, light neutral background. Centered composition with generous negative space. Single simple recognizable object or scene.'),
  make('soft-clay', 'Soft 3D Clay / Plasticine', 'Soft 3D clay render with rounded forms, slightly squishy matte surfaces and subtle surface imperfections. Pastel muted colors, soft even lighting with gentle shadows, plain light background. Centered clean composition. Single simple recognizable object or scene. No metallic shine.'),
  make('studio-photo', 'Clean Photorealistic Studio', 'Photorealistic studio product photography, soft natural lighting, gentle shadows, matte and lightly textured surfaces. Neutral muted color palette, clean light gray or off-white background. Centered, sharp focus, professional commercial look. Single simple recognizable object. No dramatic lighting.'),
  make('flat-vector', 'Flat Vector Illustration', 'Clean flat vector illustration with simple geometric shapes, solid colors and minimal shading, crisp edges. Muted natural color palette, light neutral background. Centered composition with lots of negative space. Single simple recognizable object or scene. No gradients.'),
  make('watercolor', 'Soft Watercolor', 'Soft watercolor illustration with gentle washes, visible paper texture, soft edges and slight color bleeding. Natural muted colors, light off-white background. Airy centered composition. Single simple recognizable object or scene. No hard lines.'),
  make('isometric-3d', 'Soft Isometric 3D', 'Isometric soft 3D illustration with rounded forms, matte surfaces and subtle soft shadows. Muted natural color palette, plain light background. Clean isometric view, centered. Single simple recognizable object or small scene.'),
  make('line-art', 'Refined Line Art', 'Refined minimal line-art illustration with confident thin charcoal-gray outlines, sparse color accents, subtle paper grain and almost no shading. Balanced editorial composition with generous negative space. Single simple recognizable object or scene.'),
  make('paper-cut', 'Layered Paper Cut', 'Handcrafted layered paper-cut illustration with clean cut edges, shallow dimensional layers, subtle paper fibers and soft cast shadows. Muted natural colors, tidy centered composition. Single simple recognizable object or scene. No plastic shine.'),
  make('vintage-editorial', 'Vintage Editorial', 'Mid-century vintage editorial illustration with simplified organic shapes, restrained screen-print texture, subtle ink grain and slightly imperfect registration. Warm paper background and a balanced centered composition. Single simple recognizable object or scene.'),
  make('low-poly', 'Low-Poly 3D', 'Clean low-poly 3D illustration with clearly faceted geometry, matte materials, soft ambient occlusion and gentle studio shadows. Muted natural colors, light neutral background, balanced centered composition. Single simple recognizable object or scene. No glossy reflections.')
];

export function freshTemplates() { return structuredClone(BUILTIN_TEMPLATES); }

export function composeTemplateStyle(template, toneId) {
  const tone = template?.tones?.find(item => item.id === toneId) || template?.tones?.[0];
  if (!template || !tone) throw new Error('Template or tone not found.');
  const prompt = template.prompt.trim(); const negative = prompt.endsWith(NEGATIVE) ? NEGATIVE : '';
  const core = negative ? prompt.slice(0, -negative.length).trim() : prompt;
  return `${core}\n\nColor tone: ${tone.prompt.trim()}${negative ? `\n\n${negative}` : ''}`;
}
