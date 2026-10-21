import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/merchant', '/admin', '/me', '/api', '/login', '/register', '/go'] },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
