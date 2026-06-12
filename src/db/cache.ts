// =============================================================
// Cache — ioredis (Railway Redis)
// Conexión TCP estándar, mucho más rápida que HTTP en un servidor siempre activo
// =============================================================

import Redis from 'ioredis'
import type { CacheAdapter } from '../lookup/lookup-service'

let client: Redis | null = null

function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL
    if (!url) throw new Error('REDIS_URL no definida')
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    })
    client.on('error', err => console.warn('[Redis] Error:', err.message))
  }
  return client
}

// Adaptador para el LookupService
export const redisCacheAdapter: CacheAdapter = {
  async get(key: string): Promise<string | null> {
    try {
      return await getRedis().get(key)
    } catch (err) {
      console.warn('[Cache] get error:', key, err)
      return null
    }
  },

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await getRedis().setex(key, ttlSeconds, value)
    } catch (err) {
      console.warn('[Cache] set error:', key, err)
      // No fallar si el cache no está disponible
    }
  },
}

// Helpers de propósito general
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const val = await getRedis().get(key)
      return val ? JSON.parse(val) as T : null
    } catch { return null }
  },

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    try {
      await getRedis().setex(key, ttlSeconds, JSON.stringify(value))
    } catch { /* silencioso */ }
  },

  async del(key: string): Promise<void> {
    try { await getRedis().del(key) } catch { /* silencioso */ }
  },
}
