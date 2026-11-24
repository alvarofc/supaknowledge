import { KeyRound, Mail, MailCheck } from "lucide-react";
import { Link } from "@/components/ui/link";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { Segmented } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";
type Method = "password" | "magic";

export function AuthForm({ mode, next, initialError }: { mode: Mode; next: string; initialError?: string }) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const callback = () => {
    const url = new URL("/auth/callback", window.location.origin);
    url.searchParams.set("next", next);
    return url.toString();
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const supabase = createClient();
    try {
      if (method === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: callback(),
            shouldCreateUser: mode === "signup",
            data: mode === "signup" && name ? { display_name: name } : undefined,
          },
        });
        if (error) throw error;
        setSentTo(email);
        return;
      }
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: callback(), data: name ? { display_name: name } : undefined },
        });
        if (error) throw error;
        if (!data.session) {
          // email confirmation is on: the session starts when they click the link
          setSentTo(email);
          return;
        }
      }
      void router.navigate({ href: next, replace: true });
    } catch (err) {
      const msg = (err as { message?: string }).message ?? "Something went wrong";
      setError(
        /invalid login credentials/i.test(msg)
          ? "Wrong email or password."
          : /signups not allowed for otp/i.test(msg)
            ? "No account with that email yet. Create one first."
            : msg,
      );
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <div className="rounded-md border border-line bg-surface p-5 text-center">
        <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-md border border-accent/30 bg-accent-soft text-accent">
          <MailCheck className="size-4" />
        </div>
        <h2 className="text-base font-medium">Check your email</h2>
        <p className="mt-1 text-sm text-muted">
          We sent a sign-in link to <span className="font-medium text-fg">{sentTo}</span>. Open it on this device to continue.
        </p>
        <p className="mt-3 text-xs text-subtle">Running locally? Emails land in Mailpit at http://127.0.0.1:54324.</p>
        <Button variant="ghost" size="sm" className="mt-4" onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </div>
    );
  }

  const nextQuery = next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate={false}>
      <div>
        <Segmented
          className="flex w-full"
          label="Sign-in method"
          value={method}
          onChange={setMethod}
          options={[
            { value: "password", label: <span className="inline-flex items-center gap-1"><KeyRound className="size-3" /> Password</span> },
            { value: "magic", label: <span className="inline-flex items-center gap-1"><Mail className="size-3" /> Email link</span> },
          ]}
        />
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {mode === "signup" ? (
        <Field label="Your name" htmlFor="name" optional>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </Field>
      ) : null}
      <Field label="Email" htmlFor="email">
        <Input
          id="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </Field>
      {method === "password" ? (
        <Field label="Password" htmlFor="password" hint={mode === "signup" ? "At least 6 characters." : undefined}>
          <Input
            id="password"
            type="password"
            required
            minLength={6}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      ) : (
        <p className="text-xs text-subtle">We&apos;ll email you a one-time link. No password needed.</p>
      )}
      <Button type="submit" variant="primary" size="lg" pending={pending} className="mt-1 w-full">
        {method === "magic" ? "Email me a link" : mode === "signin" ? "Sign in" : "Create account"}
      </Button>
      <p className="mt-2 text-center text-sm text-muted">
        {mode === "signin" ? (
          <>
            New to Supaknowledge?{" "}
            <Link className="text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg" href={`/signup${nextQuery}`}>
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link className="text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg" href={`/login${nextQuery}`}>
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
