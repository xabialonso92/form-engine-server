// =============================================================
// HTTP Adapter — para el LookupService
// Llama a la API externa del cliente para verificar el dato maestro
// =============================================================

import type { LookupClientAdapter } from '../lookup/lookup-service'

export const httpLookupAdapter: LookupClientAdapter = {
  async query(
    endpoint: string,
    method: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000) // 8s timeout

    try {
      const res = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':   'FormEngine/1.0',
          ...headers,
        },
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!res.ok) {
        // 404 = no encontrado, no es error técnico
        if (res.status === 404) return null
        throw new Error(`Lookup respondió con status ${res.status}`)
      }

      return await res.json()
    } catch (err: any) {
      clearTimeout(timeout)
      if (err.name === 'AbortError') {
        throw new Error('Timeout al consultar el lookup externo (>8s)')
      }
      throw err
    }
  },
}
