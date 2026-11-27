
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "agents": {
                  Row: {
                    "created_at": string,"created_by": string | null,"description": string | null,"id": string,"key_prefix": string | null,"last_seen_at": string | null,"name": string,"revoked_at": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id": string,"key_prefix"?: string | null,"last_seen_at"?: string | null,"name": string,"revoked_at"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"key_prefix"?: string | null,"last_seen_at"?: string | null,"name"?: string,"revoked_at"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agents_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"actor": string,"actor_user_id": string | null,"at": string,"data": NonNullable<Json>,"id": number,"space_id": string | null,"target_id": string | null,"target_kind": string | null,"workspace_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor": string,"actor_user_id"?: string | null,"at"?: string,"data"?: NonNullable<Json>,"id"?: never,"space_id"?: string | null,"target_id"?: string | null,"target_kind"?: string | null,"workspace_id"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor"?: string,"actor_user_id"?: string | null,"at"?: string,"data"?: NonNullable<Json>,"id"?: never,"space_id"?: string | null,"target_id"?: string | null,"target_kind"?: string | null,"workspace_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_log_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "audit_log_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"concept_chunks": {
                  Row: {
                    "concept_id": string,"content": string,"embedding": string | null,"fts": unknown,"heading": string | null,"id": string,"ord": number,"revision": number,"space_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "concept_id": string,"content": string,"embedding"?: string | null,"fts"?: never,"heading"?: string | null,"id"?: string,"ord": number,"revision": number,"space_id": string
                  }
                  Update: {
                    "concept_id"?: string,"content"?: string,"embedding"?: string | null,"fts"?: never,"heading"?: string | null,"id"?: string,"ord"?: number,"revision"?: number,"space_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "concept_chunks_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_chunks_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"concept_files": {
                  Row: {
                    "concept_id": string,"content_type": string | null,"created_at": string,"id": string,"path": string,"sha256": string | null,"size_bytes": number | null,"space_id": string,"storage_path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "concept_id": string,"content_type"?: string | null,"created_at"?: string,"id"?: string,"path": string,"sha256"?: string | null,"size_bytes"?: number | null,"space_id": string,"storage_path": string
                  }
                  Update: {
                    "concept_id"?: string,"content_type"?: string | null,"created_at"?: string,"id"?: string,"path"?: string,"sha256"?: string | null,"size_bytes"?: number | null,"space_id"?: string,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "concept_files_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_files_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"concept_links": {
                  Row: {
                    "anchor": string | null,"from_concept": string,"space_id": string,"to_concept": string | null,"to_path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "anchor"?: string | null,"from_concept": string,"space_id": string,"to_concept"?: string | null,"to_path": string
                  }
                  Update: {
                    "anchor"?: string | null,"from_concept"?: string,"space_id"?: string,"to_concept"?: string | null,"to_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "concept_links_from_concept_fkey"
      columns: ["from_concept"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_links_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_links_to_concept_fkey"
      columns: ["to_concept"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    }
                  ]
                },"concept_revisions": {
                  Row: {
                    "actor": string,"actor_user_id": string | null,"audience": (string)[],"body": string,"concept_id": string,"created_at": string,"description": string,"frontmatter": NonNullable<Json>,"id": string,"kind": Database["public"]['Enums']["concept_kind"],"path": string,"proposal_id": string | null,"reason": string | null,"revision": number,"space_id": string,"stale_after": string | null,"status": Database["public"]['Enums']["concept_status"],"superseded_by": string | null,"tags": (string)[],"title": string,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor": string,"actor_user_id"?: string | null,"audience": (string)[],"body": string,"concept_id": string,"created_at"?: string,"description": string,"frontmatter": NonNullable<Json>,"id"?: string,"kind": Database["public"]['Enums']["concept_kind"],"path": string,"proposal_id"?: string | null,"reason"?: string | null,"revision": number,"space_id": string,"stale_after"?: string | null,"status": Database["public"]['Enums']["concept_status"],"superseded_by"?: string | null,"tags": (string)[],"title": string,"type": string
                  }
                  Update: {
                    "actor"?: string,"actor_user_id"?: string | null,"audience"?: (string)[],"body"?: string,"concept_id"?: string,"created_at"?: string,"description"?: string,"frontmatter"?: NonNullable<Json>,"id"?: string,"kind"?: Database["public"]['Enums']["concept_kind"],"path"?: string,"proposal_id"?: string | null,"reason"?: string | null,"revision"?: number,"space_id"?: string,"stale_after"?: string | null,"status"?: Database["public"]['Enums']["concept_status"],"superseded_by"?: string | null,"tags"?: (string)[],"title"?: string,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "concept_revisions_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_revisions_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "revisions_proposal_fk"
      columns: ["proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["id"]
    }
                  ]
                },"concept_usage": {
                  Row: {
                    "at": string,"concept_id": string,"id": number,"principal_id": string | null,"query": string | null,"revision": number,"space_id": string,"trace_id": string | null,"via": string
                  }
                  ComputedFields: never
                  Insert: {
                    "at"?: string,"concept_id": string,"id"?: never,"principal_id"?: string | null,"query"?: string | null,"revision": number,"space_id": string,"trace_id"?: string | null,"via"?: string
                  }
                  Update: {
                    "at"?: string,"concept_id"?: string,"id"?: never,"principal_id"?: string | null,"query"?: string | null,"revision"?: number,"space_id"?: string,"trace_id"?: string | null,"via"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "concept_usage_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_usage_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "concept_usage_trace_id_fkey"
      columns: ["trace_id"]
isOneToOne: false
      referencedRelation: "traces"
      referencedColumns: ["id"]
    }
                  ]
                },"concepts": {
                  Row: {
                    "audience": (string)[],"body": string,"created_at": string,"description": string,"frontmatter": NonNullable<Json>,"fts": unknown,"generated_at": string,"generated_by": string | null,"id": string,"kind": Database["public"]['Enums']["concept_kind"],"path": string,"revision": number,"space_id": string,"stale_after": string | null,"status": Database["public"]['Enums']["concept_status"],"superseded_by": string | null,"tags": (string)[],"title": string,"type": string,"updated_at": string,"is_stale": boolean | null,"trust": Database["public"]['Enums']["trust_tier"] | null
                  }
                  ComputedFields: "is_stale" | "trust"
                  Insert: {
                    "audience"?: (string)[],"body"?: string,"created_at"?: string,"description"?: string,"frontmatter"?: NonNullable<Json>,"fts"?: never,"generated_at"?: string,"generated_by"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["concept_kind"],"path": string,"revision"?: number,"space_id": string,"stale_after"?: string | null,"status"?: Database["public"]['Enums']["concept_status"],"superseded_by"?: string | null,"tags"?: (string)[],"title": string,"type": string,"updated_at"?: string
                  }
                  Update: {
                    "audience"?: (string)[],"body"?: string,"created_at"?: string,"description"?: string,"frontmatter"?: NonNullable<Json>,"fts"?: never,"generated_at"?: string,"generated_by"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["concept_kind"],"path"?: string,"revision"?: number,"space_id"?: string,"stale_after"?: string | null,"status"?: Database["public"]['Enums']["concept_status"],"superseded_by"?: string | null,"tags"?: (string)[],"title"?: string,"type"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "concepts_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"curator_runs": {
                  Row: {
                    "created_at": string,"error": string | null,"finished_at": string | null,"id": string,"requested_by": string | null,"since": string | null,"space_id": string,"started_at": string | null,"stats": NonNullable<Json>,"status": Database["public"]['Enums']["run_status"],"trigger": string,"until": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"requested_by"?: string | null,"since"?: string | null,"space_id": string,"started_at"?: string | null,"stats"?: NonNullable<Json>,"status"?: Database["public"]['Enums']["run_status"],"trigger": string,"until"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"requested_by"?: string | null,"since"?: string | null,"space_id"?: string,"started_at"?: string | null,"stats"?: NonNullable<Json>,"status"?: Database["public"]['Enums']["run_status"],"trigger"?: string,"until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "curator_runs_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"curator_tasks": {
                  Row: {
                    "attempts": number,"created_at": string,"error": string | null,"finished_at": string | null,"id": string,"input": NonNullable<Json>,"output": Json | null,"run_id": string,"space_id": string,"status": Database["public"]['Enums']["run_status"],"step": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"input"?: NonNullable<Json>,"output"?: Json | null,"run_id": string,"space_id": string,"status"?: Database["public"]['Enums']["run_status"],"step": string
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"input"?: NonNullable<Json>,"output"?: Json | null,"run_id"?: string,"space_id"?: string,"status"?: Database["public"]['Enums']["run_status"],"step"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "curator_tasks_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "curator_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "curator_tasks_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"flags": {
                  Row: {
                    "audience": (string)[],"concept_id": string | null,"concept_path": string | null,"created_at": string,"created_by": string | null,"evidence": NonNullable<Json>,"id": string,"kind": Database["public"]['Enums']["flag_kind"],"observation": string,"proposal_id": string | null,"query": string | null,"resolution": string | null,"resolved_at": string | null,"resolved_by": string | null,"space_id": string,"status": Database["public"]['Enums']["flag_status"],"suggested_fix": string | null,"synthetic": boolean,"trace_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "audience"?: (string)[],"concept_id"?: string | null,"concept_path"?: string | null,"created_at"?: string,"created_by"?: string | null,"evidence"?: NonNullable<Json>,"id"?: string,"kind": Database["public"]['Enums']["flag_kind"],"observation": string,"proposal_id"?: string | null,"query"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"space_id": string,"status"?: Database["public"]['Enums']["flag_status"],"suggested_fix"?: string | null,"synthetic"?: boolean,"trace_id"?: string | null
                  }
                  Update: {
                    "audience"?: (string)[],"concept_id"?: string | null,"concept_path"?: string | null,"created_at"?: string,"created_by"?: string | null,"evidence"?: NonNullable<Json>,"id"?: string,"kind"?: Database["public"]['Enums']["flag_kind"],"observation"?: string,"proposal_id"?: string | null,"query"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"space_id"?: string,"status"?: Database["public"]['Enums']["flag_status"],"suggested_fix"?: string | null,"synthetic"?: boolean,"trace_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "flags_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "flags_proposal_fk"
      columns: ["proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "flags_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "flags_trace_id_fkey"
      columns: ["trace_id"]
isOneToOne: false
      referencedRelation: "traces"
      referencedColumns: ["id"]
    }
                  ]
                },"group_members": {
                  Row: {
                    "created_at": string,"group_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"group_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"group_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "group_members_group_id_fkey"
      columns: ["group_id"]
isOneToOne: false
      referencedRelation: "groups"
      referencedColumns: ["id"]
    }
                  ]
                },"groups": {
                  Row: {
                    "created_at": string,"description": string | null,"external_ref": NonNullable<Json>,"id": string,"name": string,"slug": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"external_ref"?: NonNullable<Json>,"id"?: string,"name": string,"slug": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"external_ref"?: NonNullable<Json>,"id"?: string,"name"?: string,"slug"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "groups_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"kf_storage_gc": {
                  Row: {
                    "attempts": number,"bucket": string,"created_at": string,"id": number,"last_error": string | null,"prefix": string,"reason": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"bucket": string,"created_at"?: string,"id"?: never,"last_error"?: string | null,"prefix": string,"reason": string
                  }
                  Update: {
                    "attempts"?: number,"bucket"?: string,"created_at"?: string,"id"?: never,"last_error"?: string | null,"prefix"?: string,"reason"?: string
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"display_name": string | null,"id": string,"kind": Database["public"]['Enums']["principal_kind"]
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"id": string,"kind"?: Database["public"]['Enums']["principal_kind"]
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["principal_kind"]
                  }
                  Relationships: [
                    
                  ]
                },"proposal_citations": {
                  Row: {
                    "audience": (string)[],"consulted": boolean,"id": string,"label": string,"op_id": string | null,"proposal_id": string,"quote": string | null,"ref_id": string | null,"ref_kind": Database["public"]['Enums']["citation_kind"],"space_id": string,"url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "audience"?: (string)[],"consulted"?: boolean,"id"?: string,"label": string,"op_id"?: string | null,"proposal_id": string,"quote"?: string | null,"ref_id"?: string | null,"ref_kind": Database["public"]['Enums']["citation_kind"],"space_id": string,"url"?: string | null
                  }
                  Update: {
                    "audience"?: (string)[],"consulted"?: boolean,"id"?: string,"label"?: string,"op_id"?: string | null,"proposal_id"?: string,"quote"?: string | null,"ref_id"?: string | null,"ref_kind"?: Database["public"]['Enums']["citation_kind"],"space_id"?: string,"url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_citations_proposal_id_fkey"
      columns: ["proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "proposal_citations_proposal_id_op_id_fkey"
      columns: ["proposal_id","op_id"]
isOneToOne: false
      referencedRelation: "proposal_ops"
      referencedColumns: ["proposal_id","id"]
    },{
      foreignKeyName: "proposal_citations_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_ops": {
                  Row: {
                    "after": NonNullable<Json>,"base_revision": number | null,"concept_id": string | null,"id": string,"new_path": string | null,"op": Database["public"]['Enums']["proposal_op_kind"],"ord": number,"path": string,"proposal_id": string,"rationale": string | null,"space_id": string,"target_audience": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "after"?: NonNullable<Json>,"base_revision"?: number | null,"concept_id"?: string | null,"id"?: string,"new_path"?: string | null,"op": Database["public"]['Enums']["proposal_op_kind"],"ord": number,"path": string,"proposal_id": string,"rationale"?: string | null,"space_id": string,"target_audience"?: (string)[]
                  }
                  Update: {
                    "after"?: NonNullable<Json>,"base_revision"?: number | null,"concept_id"?: string | null,"id"?: string,"new_path"?: string | null,"op"?: Database["public"]['Enums']["proposal_op_kind"],"ord"?: number,"path"?: string,"proposal_id"?: string,"rationale"?: string | null,"space_id"?: string,"target_audience"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_ops_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "proposal_ops_proposal_id_fkey"
      columns: ["proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "proposal_ops_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_reviews": {
                  Row: {
                    "created_at": string,"decision": Database["public"]['Enums']["review_decision"],"id": string,"note": string | null,"proposal_id": string,"reviewer": string | null,"space_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"decision": Database["public"]['Enums']["review_decision"],"id"?: string,"note"?: string | null,"proposal_id": string,"reviewer"?: string | null,"space_id": string
                  }
                  Update: {
                    "created_at"?: string,"decision"?: Database["public"]['Enums']["review_decision"],"id"?: string,"note"?: string | null,"proposal_id"?: string,"reviewer"?: string | null,"space_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_reviews_proposal_id_fkey"
      columns: ["proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "proposal_reviews_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"proposals": {
                  Row: {
                    "applied_at": string | null,"author": string,"auto_applied": boolean,"created_at": string,"created_by": string | null,"escalation": boolean,"id": string,"rationale": string,"review_note": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"risk": Database["public"]['Enums']["proposal_risk"],"run_id": string | null,"space_id": string,"status": Database["public"]['Enums']["proposal_status"],"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applied_at"?: string | null,"author": string,"auto_applied"?: boolean,"created_at"?: string,"created_by"?: string | null,"escalation"?: boolean,"id"?: string,"rationale"?: string,"review_note"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"risk"?: Database["public"]['Enums']["proposal_risk"],"run_id"?: string | null,"space_id": string,"status"?: Database["public"]['Enums']["proposal_status"],"title": string
                  }
                  Update: {
                    "applied_at"?: string | null,"author"?: string,"auto_applied"?: boolean,"created_at"?: string,"created_by"?: string | null,"escalation"?: boolean,"id"?: string,"rationale"?: string,"review_note"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"risk"?: Database["public"]['Enums']["proposal_risk"],"run_id"?: string | null,"space_id"?: string,"status"?: Database["public"]['Enums']["proposal_status"],"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposals_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "curator_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "proposals_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"source_chunks": {
                  Row: {
                    "content": string,"document_id": string,"embedding": string | null,"fts": unknown,"heading": string | null,"id": string,"ord": number,"space_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content": string,"document_id": string,"embedding"?: string | null,"fts"?: never,"heading"?: string | null,"id"?: string,"ord": number,"space_id": string
                  }
                  Update: {
                    "content"?: string,"document_id"?: string,"embedding"?: string | null,"fts"?: never,"heading"?: string | null,"id"?: string,"ord"?: number,"space_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_chunks_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "source_documents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_chunks_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"source_documents": {
                  Row: {
                    "audience": (string)[],"author": string | null,"changed_at": string,"content": string,"content_hash": string,"deleted_at": string | null,"external_id": string,"external_updated_at": string | null,"id": string,"metadata": NonNullable<Json>,"mime_type": string | null,"source_id": string,"space_id": string,"storage_path": string | null,"synced_at": string,"title": string | null,"url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "audience"?: (string)[],"author"?: string | null,"changed_at"?: string,"content"?: string,"content_hash": string,"deleted_at"?: string | null,"external_id": string,"external_updated_at"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"mime_type"?: string | null,"source_id": string,"space_id": string,"storage_path"?: string | null,"synced_at"?: string,"title"?: string | null,"url"?: string | null
                  }
                  Update: {
                    "audience"?: (string)[],"author"?: string | null,"changed_at"?: string,"content"?: string,"content_hash"?: string,"deleted_at"?: string | null,"external_id"?: string,"external_updated_at"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"mime_type"?: string | null,"source_id"?: string,"space_id"?: string,"storage_path"?: string | null,"synced_at"?: string,"title"?: string | null,"url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_documents_source_id_fkey"
      columns: ["source_id"]
isOneToOne: false
      referencedRelation: "sources"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_documents_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"sources": {
                  Row: {
                    "audience": (string)[],"config": NonNullable<Json>,"connector": Database["public"]['Enums']["connector_kind"],"created_at": string,"created_by": string | null,"cursor": NonNullable<Json>,"id": string,"last_error": string | null,"last_synced_at": string | null,"name": string,"secret_id": string | null,"space_id": string,"status": Database["public"]['Enums']["source_status"],"sync_interval": string,"sync_requested_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "audience"?: (string)[],"config"?: NonNullable<Json>,"connector": Database["public"]['Enums']["connector_kind"],"created_at"?: string,"created_by"?: string | null,"cursor"?: NonNullable<Json>,"id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"name": string,"secret_id"?: string | null,"space_id": string,"status"?: Database["public"]['Enums']["source_status"],"sync_interval"?: string,"sync_requested_at"?: string | null
                  }
                  Update: {
                    "audience"?: (string)[],"config"?: NonNullable<Json>,"connector"?: Database["public"]['Enums']["connector_kind"],"created_at"?: string,"created_by"?: string | null,"cursor"?: NonNullable<Json>,"id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"name"?: string,"secret_id"?: string | null,"space_id"?: string,"status"?: Database["public"]['Enums']["source_status"],"sync_interval"?: string,"sync_requested_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sources_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"space_group_grants": {
                  Row: {
                    "created_at": string,"group_id": string,"role": Database["public"]['Enums']["space_role"],"space_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"group_id": string,"role"?: Database["public"]['Enums']["space_role"],"space_id": string
                  }
                  Update: {
                    "created_at"?: string,"group_id"?: string,"role"?: Database["public"]['Enums']["space_role"],"space_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "space_group_grants_group_id_fkey"
      columns: ["group_id"]
isOneToOne: false
      referencedRelation: "groups"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "space_group_grants_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"space_members": {
                  Row: {
                    "created_at": string,"role": Database["public"]['Enums']["space_role"],"space_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["space_role"],"space_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["space_role"],"space_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "space_members_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"spaces": {
                  Row: {
                    "created_at": string,"description": string | null,"id": string,"name": string,"settings": NonNullable<Json>,"slug": string,"visibility": Database["public"]['Enums']["space_visibility"],"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"name": string,"settings"?: NonNullable<Json>,"slug": string,"visibility"?: Database["public"]['Enums']["space_visibility"],"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"name"?: string,"settings"?: NonNullable<Json>,"slug"?: string,"visibility"?: Database["public"]['Enums']["space_visibility"],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "spaces_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"trace_events": {
                  Row: {
                    "at": string,"content": string | null,"id": number,"is_error": boolean,"metadata": NonNullable<Json>,"role": Database["public"]['Enums']["trace_role"],"seq": number,"space_id": string,"tool_input": Json | null,"tool_name": string | null,"tool_output": Json | null,"trace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "at"?: string,"content"?: string | null,"id"?: never,"is_error"?: boolean,"metadata"?: NonNullable<Json>,"role": Database["public"]['Enums']["trace_role"],"seq": number,"space_id": string,"tool_input"?: Json | null,"tool_name"?: string | null,"tool_output"?: Json | null,"trace_id": string
                  }
                  Update: {
                    "at"?: string,"content"?: string | null,"id"?: never,"is_error"?: boolean,"metadata"?: NonNullable<Json>,"role"?: Database["public"]['Enums']["trace_role"],"seq"?: number,"space_id"?: string,"tool_input"?: Json | null,"tool_name"?: string | null,"tool_output"?: Json | null,"trace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "trace_events_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "trace_events_trace_id_fkey"
      columns: ["trace_id"]
isOneToOne: false
      referencedRelation: "traces"
      referencedColumns: ["id"]
    }
                  ]
                },"traces": {
                  Row: {
                    "audience": (string)[],"created_at": string,"curated_at": string | null,"ended_at": string | null,"external_id": string | null,"id": string,"metadata": NonNullable<Json>,"name": string | null,"on_behalf_of": string | null,"outcome": Database["public"]['Enums']["trace_outcome"],"principal_id": string | null,"space_id": string,"started_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "audience"?: (string)[],"created_at"?: string,"curated_at"?: string | null,"ended_at"?: string | null,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string | null,"on_behalf_of"?: string | null,"outcome"?: Database["public"]['Enums']["trace_outcome"],"principal_id"?: string | null,"space_id": string,"started_at"?: string
                  }
                  Update: {
                    "audience"?: (string)[],"created_at"?: string,"curated_at"?: string | null,"ended_at"?: string | null,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string | null,"on_behalf_of"?: string | null,"outcome"?: Database["public"]['Enums']["trace_outcome"],"principal_id"?: string | null,"space_id"?: string,"started_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "traces_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"verifications": {
                  Row: {
                    "actor": string,"actor_user_id": string | null,"concept_id": string,"created_at": string,"id": string,"note": string | null,"revision": number,"space_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor": string,"actor_user_id"?: string | null,"concept_id": string,"created_at"?: string,"id"?: string,"note"?: string | null,"revision": number,"space_id": string
                  }
                  Update: {
                    "actor"?: string,"actor_user_id"?: string | null,"concept_id"?: string,"created_at"?: string,"id"?: string,"note"?: string | null,"revision"?: number,"space_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "verifications_concept_id_fkey"
      columns: ["concept_id"]
isOneToOne: false
      referencedRelation: "concepts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "verifications_space_id_fkey"
      columns: ["space_id"]
isOneToOne: false
      referencedRelation: "spaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspace_invitations": {
                  Row: {
                    "accepted_at": string | null,"created_at": string,"declined_at": string | null,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"role": Database["public"]['Enums']["workspace_role"],"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"created_at"?: string,"declined_at"?: string | null,"email": string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"role"?: Database["public"]['Enums']["workspace_role"],"workspace_id": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"created_at"?: string,"declined_at"?: string | null,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"role"?: Database["public"]['Enums']["workspace_role"],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_invitations_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspace_members": {
                  Row: {
                    "created_at": string,"role": Database["public"]['Enums']["workspace_role"],"user_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["workspace_role"],"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["workspace_role"],"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_members_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"name": string,"slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"slug": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"slug"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_invitation":
{ Args: { "p_id": string }; Returns: {
              "created_at": string,
"created_by": string | null,
"id": string,
"name": string,
"slug": string
            }
                          SetofOptions: {
        from: "*"
        to: "workspaces"
        isOneToOne: true
        isSetofReturn: false
      } },
"apply_proposal":
{ Args: { "p_actor"?: string,"p_note"?: string,"p_proposal": string }; Returns: {
              "applied_at": string | null,
"author": string,
"auto_applied": boolean,
"created_at": string,
"created_by": string | null,
"escalation": boolean,
"id": string,
"rationale": string,
"review_note": string | null,
"reviewed_at": string | null,
"reviewed_by": string | null,
"risk": Database["public"]['Enums']["proposal_risk"],
"run_id": string | null,
"space_id": string,
"status": Database["public"]['Enums']["proposal_status"],
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "proposals"
        isOneToOne: true
        isSetofReturn: false
      } },
"cancel_curator_run":
{ Args: { "p_run": string }; Returns: {
              "created_at": string,
"error": string | null,
"finished_at": string | null,
"id": string,
"requested_by": string | null,
"since": string | null,
"space_id": string,
"started_at": string | null,
"stats": NonNullable<Json>,
"status": Database["public"]['Enums']["run_status"],
"trigger": string,
"until": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "curator_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_proposal":
{ Args: { "p_author"?: string,"p_citations"?: Json,"p_ops": Json,"p_rationale": string,"p_risk": Database["public"]['Enums']["proposal_risk"],"p_run"?: string,"p_space": string,"p_title": string }; Returns: {
              "applied_at": string | null,
"author": string,
"auto_applied": boolean,
"created_at": string,
"created_by": string | null,
"escalation": boolean,
"id": string,
"rationale": string,
"review_note": string | null,
"reviewed_at": string | null,
"reviewed_by": string | null,
"risk": Database["public"]['Enums']["proposal_risk"],
"run_id": string | null,
"space_id": string,
"status": Database["public"]['Enums']["proposal_status"],
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "proposals"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_space":
{ Args: { "p_description"?: string,"p_name": string,"p_slug": string,"p_visibility"?: Database["public"]['Enums']["space_visibility"],"p_workspace": string }; Returns: {
              "created_at": string,
"description": string | null,
"id": string,
"name": string,
"settings": NonNullable<Json>,
"slug": string,
"visibility": Database["public"]['Enums']["space_visibility"],
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "spaces"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_workspace":
{ Args: { "p_name": string,"p_slug": string }; Returns: {
              "created_at": string,
"created_by": string | null,
"id": string,
"name": string,
"slug": string
            }
                          SetofOptions: {
        from: "*"
        to: "workspaces"
        isOneToOne: true
        isSetofReturn: false
      } },
"decline_invitation":
{ Args: { "p_id": string }; Returns: undefined
                           },
"dismiss_flag":
{ Args: { "p_flag": string,"p_reason": string }; Returns: {
              "audience": (string)[],
"concept_id": string | null,
"concept_path": string | null,
"created_at": string,
"created_by": string | null,
"evidence": NonNullable<Json>,
"id": string,
"kind": Database["public"]['Enums']["flag_kind"],
"observation": string,
"proposal_id": string | null,
"query": string | null,
"resolution": string | null,
"resolved_at": string | null,
"resolved_by": string | null,
"space_id": string,
"status": Database["public"]['Enums']["flag_status"],
"suggested_fix": string | null,
"synthetic": boolean,
"trace_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "flags"
        isOneToOne: true
        isSetofReturn: false
      } },
"flag_knowledge":
{ Args: { "p_concept_path"?: string,"p_evidence"?: Json,"p_kind": Database["public"]['Enums']["flag_kind"],"p_observation": string,"p_query"?: string,"p_space": string,"p_suggested_fix"?: string,"p_trace"?: string }; Returns: string
                           },
"invite_to_workspace":
{ Args: { "p_email": string,"p_role"?: Database["public"]['Enums']["workspace_role"],"p_workspace": string }; Returns: {
              "accepted_at": string | null,
"created_at": string,
"declined_at": string | null,
"email": string,
"expires_at": string,
"id": string,
"invited_by": string | null,
"role": Database["public"]['Enums']["workspace_role"],
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "workspace_invitations"
        isOneToOne: true
        isSetofReturn: false
      } },
"is_stale":
{ Args: { "c": Omit<Database["public"]['Tables']["concepts"]['Row'], Database["public"]['Tables']["concepts"]['ComputedFields']> }; Returns: boolean
                           },
"kf_add_run_stats":
{ Args: { "p_delta": Json,"p_run": string }; Returns: Json
                           },
"kf_allow_agent_password_change":
{ Args: { "p_agent": string }; Returns: undefined
                           },
"kf_curator_progress":
{ Args: { "p_events": Json,"p_space": string }; Returns: number
                           },
"kf_embed_requeue":
{ Args: { "p_delay"?: number,"p_message": Json,"p_msg_id": number }; Returns: boolean
                           },
"kf_embed_write_concept":
{ Args: { "p_body_sha256": string,"p_chunks": Json,"p_concept": string,"p_links"?: Json,"p_path": string,"p_revision": number,"p_total"?: number }; Returns: boolean
                           },
"kf_embed_write_document":
{ Args: { "p_chunks": Json,"p_content_hash": string,"p_document": string,"p_live": boolean,"p_total"?: number }; Returns: boolean
                           },
"kf_enqueue_curator_task":
{ Args: { "p_input": Json,"p_run": string,"p_step": string }; Returns: string
                           },
"kf_finish_task":
{ Args: { "p_error"?: string,"p_output"?: Json,"p_status": string,"p_task": string }; Returns: string
                           },
"kf_get_source_secret":
{ Args: { "p_source": string }; Returns: string
                           },
"kf_maybe_finish_run":
{ Args: { "p_run": string }; Returns: string
                           },
"kf_queue_ack":
{ Args: { "p_msg_ids": (number)[],"p_queue": string }; Returns: number
                           },
"kf_queue_archive":
{ Args: { "p_msg_ids": (number)[],"p_queue": string }; Returns: number
                           },
"kf_queue_send":
{ Args: { "p_delay"?: number,"p_messages": (Json)[],"p_queue": string }; Returns: (number)[]
                           },
"kf_rejected_proposals":
{ Args: { "p_limit"?: number,"p_paths": (string)[],"p_space": string }; Returns: {
              "audiences": Json,"id": string,"paths": (string)[],"review_note": string,"reviewed_at": string,"title": string
            }[]
                           },
"kf_revoke_user_sessions":
{ Args: { "p_user": string }; Returns: number
                           },
"kf_storage_gc_objects":
{ Args: { "p_after"?: string,"p_bucket": string,"p_limit"?: number,"p_prefix": string }; Returns: {
              "name": string
            }[]
                           },
"kf_strip_proposal_files":
{ Args: { "p_files": Json,"p_op": string }; Returns: boolean
                           },
"kf_trace_events":
{ Args: { "p_max_per_trace"?: number,"p_trace_ids": (string)[] }; Returns: Json
                           },
"knowledge_graph":
{ Args: { "p_limit"?: number,"p_space": string }; Returns: Json
                           },
"knowledge_health":
{ Args: { "p_days"?: number,"p_space": string }; Returns: Json
                           },
"knowledge_recap":
{ Args: { "p_month": string,"p_space"?: string,"p_workspace"?: string }; Returns: Json
                           },
"list_my_invitations":
{ Args: Record<PropertyKey, never>; Returns: {
              "created_at": string,"expires_at": string,"id": string,"invited_by_name": string,"role": Database["public"]['Enums']["workspace_role"],"workspace_id": string,"workspace_name": string,"workspace_slug": string
            }[]
                           },
"log_concept_usage":
{ Args: { "p_concepts": (string)[],"p_query"?: string,"p_space": string,"p_trace"?: string,"p_via"?: string }; Returns: number
                           },
"my_space_role":
{ Args: { "p_space": string }; Returns: Database["public"]['Enums']["space_role"]
                           },
"propose_revert":
{ Args: { "p_concept": string,"p_revision": number }; Returns: {
              "applied_at": string | null,
"author": string,
"auto_applied": boolean,
"created_at": string,
"created_by": string | null,
"escalation": boolean,
"id": string,
"rationale": string,
"review_note": string | null,
"reviewed_at": string | null,
"reviewed_by": string | null,
"risk": Database["public"]['Enums']["proposal_risk"],
"run_id": string | null,
"space_id": string,
"status": Database["public"]['Enums']["proposal_status"],
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "proposals"
        isOneToOne: true
        isSetofReturn: false
      } },
"read_concept":
{ Args: { "p_path": string,"p_space": string }; Returns: Json
                           },
"reject_proposal":
{ Args: { "p_note": string,"p_proposal": string }; Returns: {
              "applied_at": string | null,
"author": string,
"auto_applied": boolean,
"created_at": string,
"created_by": string | null,
"escalation": boolean,
"id": string,
"rationale": string,
"review_note": string | null,
"reviewed_at": string | null,
"reviewed_by": string | null,
"risk": Database["public"]['Enums']["proposal_risk"],
"run_id": string | null,
"space_id": string,
"status": Database["public"]['Enums']["proposal_status"],
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "proposals"
        isOneToOne: true
        isSetofReturn: false
      } },
"request_curator_run":
{ Args: { "p_space": string,"p_trigger"?: string }; Returns: {
              "created_at": string,
"error": string | null,
"finished_at": string | null,
"id": string,
"requested_by": string | null,
"since": string | null,
"space_id": string,
"started_at": string | null,
"stats": NonNullable<Json>,
"status": Database["public"]['Enums']["run_status"],
"trigger": string,
"until": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "curator_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"request_source_sync":
{ Args: { "p_source": string }; Returns: undefined
                           },
"retire_group":
{ Args: { "p_group": string,"p_replacement": string }; Returns: undefined
                           },
"search_knowledge":
{ Args: { "p_embedding"?: string,"p_include_deprecated"?: boolean,"p_kinds"?: (Database["public"]['Enums']["concept_kind"])[],"p_limit"?: number,"p_min_similarity"?: number,"p_query": string,"p_space": string,"p_visible_to"?: (string)[] }; Returns: {
              "concept_id": string,"description": string,"kind": Database["public"]['Enums']["concept_kind"],"path": string,"revision": number,"score": number,"snippet": string,"stale": boolean,"status": Database["public"]['Enums']["concept_status"],"title": string,"trust": Database["public"]['Enums']["trust_tier"],"type": string
            }[]
                           },
"search_sources":
{ Args: { "p_embedding"?: string,"p_limit"?: number,"p_min_similarity"?: number,"p_query": string,"p_source"?: string,"p_space": string,"p_visible_to"?: (string)[] }; Returns: {
              "changed_at": string,"document_id": string,"score": number,"snippet": string,"source_id": string,"title": string,"url": string
            }[]
                           },
"set_source_secret":
{ Args: { "p_secret": string,"p_source": string }; Returns: undefined
                           },
"trust":
{ Args: { "c": Omit<Database["public"]['Tables']["concepts"]['Row'], Database["public"]['Tables']["concepts"]['ComputedFields']> }; Returns: Database["public"]['Enums']["trust_tier"]
                           },
"join_demo":
{ Args: { "p_space"?: string }; Returns: Json
                           },
"kf_demo_disable":
{ Args: { "p_space": string }; Returns: Json
                           },
"kf_demo_enable":
{ Args: { "p_flags_per_day"?: number,"p_flags_per_visitor_per_hour"?: number,"p_space": string }; Returns: Json
                           },
"kf_demo_reset":
{ Args: { "p_space": string }; Returns: Json
                           },
"kf_demo_status":
{ Args: { "p_space": string }; Returns: Json
                           },
"update_space_settings":
{ Args: { "p_expected": Json,"p_settings": Json,"p_space": string }; Returns: string
                           },
"verify_concept":
{ Args: { "p_concept": string,"p_note"?: string }; Returns: {
              "actor": string,
"actor_user_id": string | null,
"concept_id": string,
"created_at": string,
"id": string,
"note": string | null,
"revision": number,
"space_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "verifications"
        isOneToOne: true
        isSetofReturn: false
      } }
          }
          Enums: {
            "citation_kind": "source_document"|"trace"|"flag"|"concept"|"url","concept_kind": "skill"|"domain"|"data_access","concept_status": "draft"|"stable"|"deprecated","connector_kind": "notion"|"slack"|"github"|"gdrive"|"web"|"upload"|"schema","flag_kind": "missing"|"incorrect"|"outdated"|"conflicting"|"unclear","flag_status": "open"|"in_proposal"|"resolved"|"dismissed","principal_kind": "human"|"agent","proposal_op_kind": "create"|"update"|"deprecate"|"move","proposal_risk": "low"|"medium"|"high","proposal_status": "pending"|"approved"|"applied"|"rejected"|"conflicted"|"superseded","review_decision": "approve"|"reject"|"comment"|"request_changes","run_status": "queued"|"running"|"succeeded"|"failed"|"cancelled","source_status": "active"|"paused"|"error","space_role": "reader"|"editor"|"reviewer"|"admin","space_visibility": "workspace"|"private","trace_outcome": "unknown"|"success"|"failure"|"corrected","trace_role": "system"|"user"|"assistant"|"tool"|"feedback","trust_tier": "unverified"|"machine_confirmed"|"human_reviewed","workspace_role": "owner"|"admin"|"member"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "citation_kind": ["source_document", "trace", "flag", "concept", "url"],"concept_kind": ["skill", "domain", "data_access"],"concept_status": ["draft", "stable", "deprecated"],"connector_kind": ["notion", "slack", "github", "gdrive", "web", "upload", "schema"],"flag_kind": ["missing", "incorrect", "outdated", "conflicting", "unclear"],"flag_status": ["open", "in_proposal", "resolved", "dismissed"],"principal_kind": ["human", "agent"],"proposal_op_kind": ["create", "update", "deprecate", "move"],"proposal_risk": ["low", "medium", "high"],"proposal_status": ["pending", "approved", "applied", "rejected", "conflicted", "superseded"],"review_decision": ["approve", "reject", "comment", "request_changes"],"run_status": ["queued", "running", "succeeded", "failed", "cancelled"],"source_status": ["active", "paused", "error"],"space_role": ["reader", "editor", "reviewer", "admin"],"space_visibility": ["workspace", "private"],"trace_outcome": ["unknown", "success", "failure", "corrected"],"trace_role": ["system", "user", "assistant", "tool", "feedback"],"trust_tier": ["unverified", "machine_confirmed", "human_reviewed"],"workspace_role": ["owner", "admin", "member"]
          }
        }
} as const
