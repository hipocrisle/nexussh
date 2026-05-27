import { useState } from "react";
import { ConnectForm } from "./ConnectForm";
import { TerminalView } from "./Terminal";
import "./App.css";

type Screen =
  | { kind: "connect" }
  | { kind: "terminal"; sessionId: string };

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "connect" });

  return (
    <main className="h-full w-full flex flex-col bg-[#0a0e0e]">
      <header className="h-9 border-b border-[#1f3a3a] flex items-center px-4 select-none">
        <span className="text-[#00ff95] font-mono text-sm tracking-wider">
          NexuSSH
        </span>
        <span className="ml-2 text-[#4a5560] font-mono text-xs">v0.0.1</span>
        {screen.kind === "terminal" && (
          <button
            onClick={() => setScreen({ kind: "connect" })}
            className="ml-auto text-[#7fd7ff] hover:text-[#00ff95] font-mono text-xs"
          >
            + new connection
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        {screen.kind === "connect" && (
          <div className="h-full flex items-center justify-center">
            <ConnectForm
              onConnected={(sessionId) => setScreen({ kind: "terminal", sessionId })}
            />
          </div>
        )}
        {screen.kind === "terminal" && (
          <TerminalView
            sessionId={screen.sessionId}
            onClose={() => setScreen({ kind: "connect" })}
          />
        )}
      </div>
    </main>
  );
}

export default App;
