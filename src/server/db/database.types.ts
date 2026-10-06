/**
 * Hand-written to match supabase/migrations/20260922120000_init_schema.sql. There's no
 * Supabase CLI in this environment to run `supabase gen types typescript`, so this is a
 * manually maintained stand-in — regenerate it that way once the project is linked, and
 * keep it in sync with the migration until then. Row values come back over the wire as
 * plain strings (timestamptz -> ISO string, date -> "YYYY-MM-DD"); repositories convert to
 * `Date` when building domain objects.
 *
 * `Relationships: []` on every table is deliberate, not an oversight: none of our queries
 * traverse a foreign key via `.select('*, other_table(*)')`, so there's nothing to declare.
 * Tables whose writes only ever go through an RPC (`tasks`, `task_history`) still need a
 * real `Insert`/`Update` shape, not `never` — postgrest-js's generic plumbing expects
 * `Record<string, unknown>`-compatible types there even if the repository layer never
 * calls `.insert()`/`.update()` on them directly.
 */

/** What `tasks.status` can hold. "late" is derived from the clock, never stored. */
type TaskStatusColumn = "upcoming" | "completed" | "skipped";
/** `task_history` statuses still allow "late": rows recorded under the old model keep it. */
type HistoryStatusColumn = TaskStatusColumn | "late";
type HistoryEventColumn = "created" | "status_changed" | "rescheduled" | "replanned";
type TaskPriorityColumn = "high" | "medium" | "low";
type TaskKindColumn = "fixed" | "flexible" | "deadline" | "optional" | "recurring";
type TaskSourceColumn = "user" | "planner";
/** 'ai' (Phase 5.3): a human-confirmed AI proposal, distinct from a manual 'user' edit and the
 *  deterministic 'system' planner. */
type HistorySourceColumn = "user" | "system" | "ai";
type PlanRevisionSourceColumn = "system" | "user" | "ai";
/** Phase 5.5. */
type AiProposalSourceColumn = "typed" | "voice";
type AiProposalValidationStatusColumn = "valid" | "partially_valid" | "invalid";
type AiProposalStatusColumn = "generated" | "confirmed" | "discarded";
/** Phase 6.2. Exactly one kind for MVP; the column exists for future extension. */
type ScheduledNotificationKindColumn = "task_reminder";
type ScheduledNotificationStatusColumn =
  "scheduled" | "claimed" | "sent" | "failed" | "canceled" | "expired";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          timezone: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          timezone?: string;
        };
        Update: {
          timezone?: string;
        };
        Relationships: [];
      };
      days: {
        Row: {
          id: string;
          user_id: string;
          local_date: string;
          timezone: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          local_date: string;
          timezone: string;
        };
        Update: {
          timezone?: string;
        };
        Relationships: [];
      };
      briefings: {
        Row: {
          id: string;
          user_id: string;
          day_id: string;
          raw_text: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          day_id: string;
          raw_text: string;
        };
        Update: {
          raw_text?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          user_id: string;
          day_id: string;
          title: string;
          notes: string | null;
          status: TaskStatusColumn;
          priority: TaskPriorityColumn;
          kind: TaskKindColumn;
          source: TaskSourceColumn;
          scheduled_start: string;
          scheduled_end: string;
          due_at: string | null;
          completed_at: string | null;
          schedule_locked: boolean;
          unscheduled: boolean;
          created_at: string;
          updated_at: string;
        };
        // Not used directly — creation goes through create_task_with_history() and status
        // changes through change_task_status() (both below), so both writes and the
        // history row they produce stay atomic. Shapes are still real, not `never`.
        Insert: {
          user_id: string;
          day_id: string;
          title: string;
          notes?: string | null;
          status?: TaskStatusColumn;
          priority?: TaskPriorityColumn;
          kind?: TaskKindColumn;
          source?: TaskSourceColumn;
          scheduled_start: string;
          scheduled_end: string;
          due_at?: string | null;
          completed_at?: string | null;
        };
        Update: {
          status?: TaskStatusColumn;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      task_history: {
        Row: {
          id: string;
          task_id: string;
          user_id: string;
          previous_status: HistoryStatusColumn | null;
          new_status: HistoryStatusColumn;
          source: HistorySourceColumn;
          event: HistoryEventColumn;
          previous_start: string | null;
          previous_end: string | null;
          new_start: string | null;
          new_end: string | null;
          previous_unscheduled: boolean | null;
          new_unscheduled: boolean | null;
          revision_id: string | null;
          changed_at: string;
        };
        // Not used directly — see the tasks table note above.
        Insert: {
          task_id: string;
          user_id: string;
          previous_status?: HistoryStatusColumn | null;
          new_status: HistoryStatusColumn;
          source?: HistorySourceColumn;
          event?: HistoryEventColumn;
        };
        Update: {
          previous_status?: HistoryStatusColumn | null;
          new_status?: HistoryStatusColumn;
        };
        Relationships: [];
      };
      plans: {
        Row: {
          id: string;
          user_id: string;
          day_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          day_id: string;
        };
        Update: {
          day_id?: string;
        };
        Relationships: [];
      };
      plan_revisions: {
        Row: {
          id: string;
          plan_id: string;
          user_id: string;
          revision_number: number;
          source: PlanRevisionSourceColumn;
          created_at: string;
        };
        Insert: {
          plan_id: string;
          user_id: string;
          revision_number: number;
          source?: PlanRevisionSourceColumn;
        };
        Update: {
          source?: PlanRevisionSourceColumn;
        };
        Relationships: [];
      };
      ai_proposals: {
        Row: {
          id: string;
          user_id: string;
          day_id: string;
          base_revision: number;
          source: AiProposalSourceColumn;
          transcript_text: string;
          understood: string;
          unresolved: unknown;
          changes: unknown;
          rejected: unknown;
          conflicts_after: unknown;
          validation_status: AiProposalValidationStatusColumn;
          status: AiProposalStatusColumn;
          created_at: string;
          confirmed_at: string | null;
          applied_revision_number: number | null;
          /** The saved briefing a proposal was planned from (Phase 8); null for "Ask AI". */
          briefing_id: string | null;
        };
        // Not used directly — every write goes through create_ai_proposal() /
        // confirm_ai_proposal_by_id() / discard_ai_proposal() (all below), never .insert()/
        // .update(). Shapes are still real, not `never`, for the same reason noted above.
        Insert: {
          user_id: string;
          day_id: string;
          base_revision: number;
          source: AiProposalSourceColumn;
          transcript_text: string;
          understood: string;
          unresolved?: unknown;
          changes: unknown;
          rejected?: unknown;
          conflicts_after?: unknown;
          validation_status: AiProposalValidationStatusColumn;
          status?: AiProposalStatusColumn;
          briefing_id?: string | null;
        };
        Update: {
          status?: AiProposalStatusColumn;
          confirmed_at?: string | null;
          applied_revision_number?: number | null;
        };
        Relationships: [];
      };
      eod_reports: {
        Row: {
          id: string;
          user_id: string;
          day_id: string;
          state_fingerprint: string;
          prompt_version: string;
          /** jsonb — re-parsed with storedEodFactsSchema on every read. */
          facts: unknown;
          /** jsonb — re-parsed with storedEodInterpretationSchema on every read. */
          interpretation: unknown;
          created_at: string;
        };
        // Not used directly — the only writer is create_eod_report() (below), never .insert()/
        // .update()/.delete(). Shapes are still real, not `never`, for the same reason noted above.
        Insert: {
          user_id: string;
          day_id: string;
          state_fingerprint: string;
          prompt_version: string;
          facts: unknown;
          interpretation: unknown;
        };
        Update: {
          prompt_version?: string;
        };
        Relationships: [];
      };
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth_key: string;
          created_at: string;
          last_seen_at: string;
          revoked_at: string | null;
        };
        // Not used directly — every write goes through register_push_subscription() /
        // revoke_push_subscription() (below), never .insert()/.update(). Shapes are still
        // real, not `never`, for the same reason noted above.
        Insert: {
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth_key: string;
        };
        Update: {
          p256dh?: string;
          auth_key?: string;
          last_seen_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      scheduled_notifications: {
        Row: {
          id: string;
          user_id: string;
          task_id: string;
          day_id: string;
          kind: ScheduledNotificationKindColumn;
          fire_at: string;
          task_scheduled_start_snapshot: string;
          status: ScheduledNotificationStatusColumn;
          claimed_at: string | null;
          attempt_count: number;
          resolved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // Not used directly — the only writer is reconcile_and_claim_notifications() (below),
        // never .insert()/.update(). Shapes are still real, not `never`, for the same reason
        // noted above.
        Insert: {
          user_id: string;
          task_id: string;
          day_id: string;
          kind?: ScheduledNotificationKindColumn;
          fire_at: string;
          task_scheduled_start_snapshot: string;
          status?: ScheduledNotificationStatusColumn;
        };
        Update: {
          fire_at?: string;
          task_scheduled_start_snapshot?: string;
          status?: ScheduledNotificationStatusColumn;
          claimed_at?: string | null;
          attempt_count?: number;
          resolved_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_task_with_history: {
        Args: {
          p_day_id: string;
          p_title: string;
          p_notes: string | null;
          p_priority: TaskPriorityColumn;
          p_kind: TaskKindColumn;
          p_scheduled_start: string;
          p_scheduled_end: string;
          p_due_at: string | null;
          p_source?: TaskSourceColumn;
        };
        Returns: Database["public"]["Tables"]["tasks"]["Row"];
      };
      change_task_status: {
        Args: {
          p_task_id: string;
          p_new_status: "completed" | "skipped";
        };
        Returns: Database["public"]["Tables"]["tasks"]["Row"];
      };
      ensure_day: {
        Args: {
          /** A calendar date (YYYY-MM-DD); omitted or null means "today" in the caller's profile timezone. */
          p_local_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["days"]["Row"];
      };
      reschedule_task: {
        Args: {
          p_task_id: string;
          p_start: string;
          p_end: string;
        };
        Returns: Database["public"]["Tables"]["tasks"]["Row"];
      };
      apply_replan: {
        Args: {
          p_day_id: string;
          /** JSON array of ReplanChangeRow (see repositories/tasks.ts). */
          p_changes: unknown;
        };
        /** The new plan revision number, or null when nothing changed. */
        Returns: number | null;
      };
      confirm_ai_proposal: {
        Args: {
          p_day_id: string;
          p_base_revision: number;
          /** JSON array of ConfirmChangeRow (see repositories/tasks.ts). */
          p_changes: unknown;
        };
        /** The new plan revision number. Never null: a proposal is always 1-20 changes. */
        Returns: number;
      };
      create_ai_proposal: {
        Args: {
          p_day_id: string;
          p_base_revision: number;
          p_source: AiProposalSourceColumn;
          p_transcript_text: string;
          p_understood: string;
          /** JSON array of strings. */
          p_unresolved: unknown;
          /** JSON array of ConfirmChangeRow — the same shape confirm_ai_proposal() accepts. */
          p_changes: unknown;
          /** JSON array of Rejection (display-only). */
          p_rejected: unknown;
          /** JSON array of ConflictAfter (display-only). */
          p_conflicts_after: unknown;
          p_validation_status: AiProposalValidationStatusColumn;
          /** Phase 8: the caller's own briefing for THIS day, when planned from one. Required for
           *  a proposal that contains `create` changes. */
          p_briefing_id?: string | null;
        };
        Returns: Database["public"]["Tables"]["ai_proposals"]["Row"];
      };
      create_eod_report: {
        Args: {
          p_day_id: string;
          /** sha-256 hex of the persisted task state the report was written against. */
          p_state_fingerprint: string;
          p_prompt_version: string;
          /** The deterministic EodFacts (see domain/eod/types.ts). */
          p_facts: unknown;
          /** The validated EodInterpretation. */
          p_interpretation: unknown;
        };
        /** The new row — or, on an exact replay of the same day-state, the existing one. */
        Returns: Database["public"]["Tables"]["eod_reports"]["Row"];
      };
      confirm_ai_proposal_by_id: {
        Args: {
          p_proposal_id: string;
        };
        /** The new plan revision number. */
        Returns: number;
      };
      discard_ai_proposal: {
        Args: {
          p_proposal_id: string;
        };
        Returns: undefined;
      };
      register_push_subscription: {
        Args: {
          p_endpoint: string;
          p_p256dh: string;
          p_auth_key: string;
        };
        Returns: Database["public"]["Tables"]["push_subscriptions"]["Row"];
      };
      revoke_push_subscription: {
        Args: {
          p_endpoint: string;
        };
        Returns: undefined;
      };
      reconcile_and_claim_notifications: {
        Args: Record<PropertyKey, never>;
        /** The rows claimed THIS invocation only — not the whole table. */
        Returns: Database["public"]["Tables"]["scheduled_notifications"]["Row"][];
      };
      mark_notification_sent: {
        Args: {
          p_notification_id: string;
        };
        Returns: undefined;
      };
      revoke_push_subscription_by_id: {
        Args: {
          p_subscription_id: string;
        };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
