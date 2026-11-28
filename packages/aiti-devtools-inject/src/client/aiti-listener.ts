/*
 * aiti-listener.ts - Continuous listener for aiti-devtools messages
 * 
 * This implementation provides:
 * 1. aiti_hello registration to establish agent session
 * 2. Continuous polling of aiti_inbox to receive messages
 * 3. Automatic acknowledgment of processed messages
 * 4. Error handling and reconnection logic
 */

// BridgeClient is attached to global window, so we access it globally
// @ts-ignore
declare const BridgeClient: any;

interface AgentSession {
  agentId: string;
  sessionId: string;
  name?: string;
  cwd?: string;
}

interface InboxMessage {
  id: string;
  kind: string;
  from: string;
  agentKey: string;
  agentId: string;
  sessionId: string;
  pageId?: string;
  url?: string;
  text: string | null;
  payload: any;
  at: string;
  status: string;
}

interface InboxResponse {
  agentKey: string;
  registered: boolean;
  messages: InboxMessage[];
  queueSize: number;
  guide: string;
}

export class AitiListener {
  private bridgeClient: typeof BridgeClient;
  private agentSession: AgentSession;
  private isListening: boolean = false;
  private pollInterval: number = 5000; // 5 seconds default
  private pollTimer: NodeJS.Timeout | null = null;
  private messageHandler: (message: InboxMessage) => Promise<void>;
  
  constructor(agentSession: AgentSession, messageHandler: (message: InboxMessage) => Promise<void>) {
    this.bridgeClient = BridgeClient;
    this.agentSession = agentSession;
    this.messageHandler = messageHandler;
  }

  /**
   * Initialize the listener by connecting to the bridge and registering
   */
  async init(baseURL: string): Promise<boolean> {
    try {
      // Connect to the bridge
      const connectResult = await new Promise<boolean>((resolve, reject) => {
        this.bridgeClient.connect({
          base: baseURL,
          instanceId: this.agentSession.agentId,
          role: 'ai',
          onStatus: (text: string, color: string) => {
            console.log(`[AitiListener] Status: ${text}`);
          },
          onReady: () => {
            console.log('[AitiListener] Connected to bridge');
            resolve(true);
          },
          onExec: (m: any, forwarded: boolean) => {
            console.log(`[AitiListener] Received exec: ${m.cmd}`);
          },
          onResult: (m: any) => {
            console.log(`[AitiListener] Received result: ${JSON.stringify(m)}`);
          },
          onEvent: (m: any) => {
            console.log(`[AitiListener] Received event: ${JSON.stringify(m)}`);
          }
        });
      });

      if (!connectResult) {
        console.error('[AitiListener] Failed to connect to bridge');
        return false;
      }

      // Register with aiti_hello
      const registerResult = await this.register();
      if (!registerResult) {
        console.error('[AitiListener] Failed to register with aiti_hello');
        return false;
      }

      console.log('[AitiListener] Successfully initialized and registered');
      return true;
    } catch (error) {
      console.error('[AitiListener] Error initializing listener:', error);
      return false;
    }
  }

  /**
   * Register with aiti_hello to establish the agent session
   */
  private async register(): Promise<boolean> {
    try {
      // Call aiti_hello tool to register
      const response = await fetch('/aiti/bridge/tool', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'aiti_hello',
          input: {
            agentId: this.agentSession.agentId,
            sessionId: this.agentSession.sessionId,
            name: this.agentSession.name,
            cwd: this.agentSession.cwd
          }
        })
      });

      if (!response.ok) {
        throw new Error(`aiti_hello registration failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      console.log('[AitiListener] aiti_hello registration result:', result);
      
      if (result.content && result.content[0] && result.content[0].text) {
        const parsed = JSON.parse(result.content[0].text);
        if (parsed.ok) {
          console.log(`[AitiListener] Registered successfully: ${parsed.agentKey}`);
          return true;
        }
      }
      
      throw new Error('aiti_hello registration response invalid');
    } catch (error) {
      console.error('[AitiListener] Error registering with aiti_hello:', error);
      return false;
    }
  }

  /**
   * Start continuous listening for messages
   */
  start(): void {
    if (this.isListening) {
      console.warn('[AitiListener] Already listening');
      return;
    }

    this.isListening = true;
    console.log(`[AitiListener] Starting continuous listening (interval: ${this.pollInterval}ms)`);
    
    // Start polling immediately
    this.pollInbox();
    
    // Set up interval polling
    this.pollTimer = setInterval(() => {
      this.pollInbox();
    }, this.pollInterval);
  }

  /**
   * Stop continuous listening
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isListening = false;
    console.log('[AitiListener] Stopped listening');
  }

  /**
   * Poll the aiti_inbox for new messages
   */
  private async pollInbox(): Promise<void> {
    try {
      // Call aiti_inbox tool to get messages
      const response = await fetch('/aiti/bridge/tool', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'aiti_inbox',
          input: {
            agentId: this.agentSession.agentId,
            sessionId: this.agentSession.sessionId
          }
        })
      });

      if (!response.ok) {
        throw new Error(`aiti_inbox polling failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (result.content && result.content[0] && result.content[0].text) {
        const inboxData = JSON.parse(result.content[0].text);
        
        if (inboxData.messages && inboxData.messages.length > 0) {
          console.log(`[AitiListener] Received ${inboxData.messages.length} messages`);
          
          // Process each message
          for (const message of inboxData.messages) {
            try {
              await this.messageHandler(message);
              
              // Acknowledge the message
              await this.acknowledgeMessage(message.id);
            } catch (error) {
              console.error(`[AitiListener] Error processing message ${message.id}:`, error);
            }
          }
        } else {
          console.log('[AitiListener] No new messages');
        }
      }
    } catch (error) {
      console.error('[AitiListener] Error polling aiti_inbox:', error);
    }
  }

  /**
   * Acknowledge a processed message
   */
  private async acknowledgeMessage(messageId: string): Promise<void> {
    try {
      const response = await fetch('/aiti/bridge/tool', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'aiti_inbox',
          input: {
            agentId: this.agentSession.agentId,
            sessionId: this.agentSession.sessionId,
            ack: [messageId]
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to acknowledge message ${messageId}: ${response.status} ${response.statusText}`);
      }
      
      console.log(`[AitiListener] Acknowledged message: ${messageId}`);
    } catch (error) {
      console.error(`[AitiListener] Error acknowledging message ${messageId}:`, error);
    }
  }

  /**
   * Set the polling interval
   */
  setPollInterval(interval: number): void {
    this.pollInterval = interval;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        this.pollInbox();
      }, this.pollInterval);
    }
  }

  /**
   * Get current listening status
   */
  isRunning(): boolean {
    return this.isListening;
  }
}

// Export a factory function for easy usage
export function createAitiListener(
  agentSession: AgentSession, 
  messageHandler: (message: InboxMessage) => Promise<void>
): AitiListener {
  return new AitiListener(agentSession, messageHandler);
}

// Example usage:
/*
const listener = createAitiListener(
  { 
    agentId: 'qoder', 
    sessionId: 'session-123', 
    name: 'Qoder AI Assistant',
    cwd: '/workspace' 
  },
  async (message) => {
    console.log('Processing message:', message);
    // Handle the message here
    // For example, if it's a user_message, respond appropriately
    if (message.kind === 'user_message') {
      console.log('User said:', message.text);
      // Add your response logic here
    }
  }
);

// Initialize and start listening
listener.init('http://localhost:8777').then(success => {
  if (success) {
    listener.start();
  }
});
*/