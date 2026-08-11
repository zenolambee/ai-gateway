import Link from 'next/link';
import { ShieldX } from 'lucide-react';

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/30 p-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger/10">
        <ShieldX className="h-7 w-7 text-danger" aria-hidden />
      </div>
      <h1 className="mt-6 text-2xl font-semibold text-foreground">403 — Access denied</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Your API key does not have permission to access this resource. Admin role is required.
      </p>
      <Link
        href="/login"
        className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Sign in with a different key
      </Link>
    </div>
  );
}
