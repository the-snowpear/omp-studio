/** A wide, tall conversation diagram from the Studio Bridge story. */
export const PREVIEW_MERMAID_LARGE = `sequenceDiagram
    autonumber
    participant U as User
    participant S as Studio
    participant R as Renderer
    participant D as Desktop
    participant B as Studio Bridge
    participant H as Host
    participant A as AgentSession
    participant T as Tools
    U->>S: Open the workspace
    S->>R: Mount the conversation
    R->>D: Connect the client context
    D->>B: Authenticate and negotiate capabilities
    B->>H: Open the workspace scope
    H->>A: Load the active session
    A-->>H: Initial operator snapshot
    H-->>B: Typed read models
    B-->>D: Context ready
    D-->>R: Bootstrap completed
    R-->>S: Show the conversation
    S-->>U: Ready for a new message
    U->>R: Submit a prompt with file references
    R->>D: Send the typed prompt command
    D->>H: Prepare session attachments
    H->>A: Run the prompt
    loop Stream the response
        A->>T: Execute a workspace tool
        T-->>A: Tool result and progress
        A-->>H: Conversation updates
        H-->>B: Ordered incremental events
        B-->>D: Deliver the event batch
        D-->>R: Update the conversation store
        R-->>U: Render the latest result
    end
    U->>R: Open a Mermaid diagram
    R->>R: Create a local diagram window
    Note over R,D: Zoom and pan keep the conversation visible
    U->>R: Start a new conversation in this window
    R->>R: Prepare an independent draft layout
    R->>D: Rebind existing terminal ownership
    D->>H: Keep the running process and output
    H-->>D: Shared terminal snapshot
    D-->>R: Preserve terminal identity
    R-->>U: New conversation, same workspace tools
    U->>R: Return to the previous conversation
    R->>D: Open the saved session context
    D->>H: Read the conversation transcript
    H-->>R: Previous messages and title
    R-->>U: Restore the original draft
`;

export const PREVIEW_MERMAID_WIDE = `flowchart LR
    A[User prompt] --> B[Composer draft] --> C[Session context] --> D[Typed command]
    D --> E[Desktop transport] --> F[Studio Bridge] --> G[Host service] --> H[AgentSession]
    H --> I[Tool execution] --> J[Incremental event] --> K[Conversation store] --> L[Markdown]
    L --> M[Mermaid SVG] --> N[Diagram window] --> O[Zoom and pan] --> P[Readable result]
`;
