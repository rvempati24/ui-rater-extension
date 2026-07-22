export interface HttpErrorShape { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }

export class ServiceClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(error: HttpErrorShape | null | undefined, status: number, fallback: string) {
    super(error?.message || `${fallback} (${status})`);
    this.name = 'ServiceClientError';
    this.code = error?.code || `http_${status}`;
    this.retryable = error?.retryable ?? (status === 408 || status === 425 || status === 429 || status >= 500);
    this.details = error?.details;
  }
}

export async function requestJson<T>(baseUrl: string, pathname: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${pathname}`, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = (body as { error?: HttpErrorShape }).error;
      throw new ServiceClientError(error, response.status, 'Service request failed');
    }
    return body as T;
  } catch (error: unknown) {
    if (error instanceof ServiceClientError) throw error;
    if ((error as { name?: string }).name === 'AbortError') throw new ServiceClientError({ code: 'request_timeout', message: 'Service request timed out', retryable: true }, 408, 'Service request timed out');
    throw new ServiceClientError({ code: 'transport_error', message: error instanceof Error ? error.message : 'Service request failed', retryable: true }, 503, 'Service request failed');
  } finally { clearTimeout(timeout); }
}
