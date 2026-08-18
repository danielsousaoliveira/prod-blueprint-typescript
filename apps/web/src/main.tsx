import { StrictMode } from 'react';
import './index.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiError } from './api/client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Do NOT retry a 4xx. A 409 means someone took the slot and a 422 means the request
      // was invalid — retrying either just produces the same failure more slowly while
      // the user waits. 5xx and network errors are worth retrying.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.problem.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // Mutations are never retried automatically. The booking mutation carries an
      // Idempotency-Key so a retry would be SAFE, but a silent retry hides latency
      // problems and the user is right there to press the button again.
      retry: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
