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
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
