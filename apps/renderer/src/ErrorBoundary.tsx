import { reportWorkbenchFailure } from "./WorkbenchHealth";
import { Component } from "react";
import type { ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

/**
 * Minimal renderer crash boundary. A render failure must never take the
 * hosting shell down; the runtime keeps running regardless.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(): void {
    reportWorkbenchFailure();
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="shell">
          <div className="panel">
            <h1>Renderer error</h1>
            <p className="muted">
              The renderer hit an unexpected error. Reload the window; the runtime is unaffected.
            </p>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
