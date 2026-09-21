import { Loader2 } from "lucide-react";
import { Button, VoidrBrand } from "@voidr/capture-design-system";

type WorkspaceLoginProps = {
  waiting: boolean;
  connecting: boolean;
  error: string;
  onConnect: () => Promise<void>;
};

export function WorkspaceLogin({ waiting, connecting, error, onConnect }: WorkspaceLoginProps) {
  const loading = waiting || connecting;
  return <main className="workspace-login" aria-label="Sign in to Voidr" lang="en">
    <div className="workspace-login-drag" aria-hidden="true" />
    <section className="workspace-login-content">
      <VoidrBrand compact />
      <h1>Confidence in every change.</h1>
      <div className="workspace-login-action" aria-live="polite" aria-busy={loading}>
        {loading ? <div className="workspace-login-progress" role="status">
          <Loader2 className="spin" size={20} aria-hidden="true" />
          <span>{waiting ? "Continue in your browser" : "Connecting to your workspace…"}</span>
        </div> : <Button variant="primary" size="lg"
          onClick={() => void onConnect()}>Sign in to Voidr</Button>}
        <p className="workspace-login-description">{waiting
          ? "Sign in and choose your workspace. We'll bring you back here when you're ready."
          : connecting ? "Just a moment. We're getting everything ready for you."
          : "We'll open your browser so you can sign in, then bring you back here."}</p>
        {error && <p className="workspace-login-error" role="alert">We couldn't complete sign-in. Please try again.</p>}
      </div>
      {waiting && <button className="workspace-login-reopen" onClick={() => void onConnect()}>Open browser again</button>}
    </section>
  </main>;
}
