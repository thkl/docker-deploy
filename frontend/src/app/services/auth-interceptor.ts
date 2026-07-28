import { HttpInterceptorFn } from '@angular/common/http';
import { adminTokenKey } from './auth';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const token = localStorage.getItem(adminTokenKey);

  if (!token || request.url.startsWith('/api/auth/')) {
    return next(request);
  }

  return next(
    request.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`,
      },
    }),
  );
};
