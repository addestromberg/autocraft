/** The execution boundary for text providers. Workflow decisions and reply validation stay with the caller. */
export type TextAgentAdapter<Request, Reply extends { text: string } | null> = (request: Request) => Promise<Reply>;
