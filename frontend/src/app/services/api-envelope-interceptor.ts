import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { catchError, map, Observable, throwError } from 'rxjs';

interface ApiSuccessEnvelope<T = unknown> {
  data: T;
}

interface ApiErrorEnvelope {
  error: {
    message: string;
    code: string;
    details?: unknown;
  };
}

export const apiEnvelopeInterceptor: HttpInterceptorFn = (request: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> => {
  if (!request.url.startsWith('/api/')) {
    return next(request);
  }

  return next(request).pipe(
    map((event) => {
      if (event instanceof HttpResponse && isSuccessEnvelope(event.body)) {
        return event.clone({ body: event.body.data });
      }

      return event;
    }),
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && isErrorEnvelope(error.error)) {
        return throwError(() => new HttpErrorResponse({
          error: {
            error: error.error.error.message,
            apiError: error.error.error,
          },
          headers: error.headers,
          status: error.status,
          statusText: error.statusText,
          url: error.url ?? undefined,
          redirected: error.redirected,
        }));
      }

      return throwError(() => error);
    }),
  );
};

function isSuccessEnvelope(body: unknown): body is ApiSuccessEnvelope {
  return typeof body === 'object' && body !== null && 'data' in body && Object.keys(body).length === 1;
}

function isErrorEnvelope(body: unknown): body is ApiErrorEnvelope {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'object'
    && error !== null
    && typeof (error as { message?: unknown }).message === 'string'
    && typeof (error as { code?: unknown }).code === 'string';
}
