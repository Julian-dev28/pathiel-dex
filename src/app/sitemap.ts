import type { MetadataRoute } from 'next';

const BASE = 'https://pathiel-dex.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
  return ['', '/venues', '/docs'].map((path) => ({
    url: `${BASE}${path}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: path === '' ? 1 : 0.7,
  }));
}
