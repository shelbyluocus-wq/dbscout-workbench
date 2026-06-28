use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub connection_id: Option<String>,
    pub connection_label: Option<String>,
    pub database: Option<String>,
    pub active_table_name: Option<String>,
    #[serde(default)]
    pub schema_summary: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub api_key: Option<String>,
    pub auth_token: Option<String>,
    pub api_url: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub permission_mode: String,
    #[serde(default)]
    pub auto_approve_writes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "op")]
pub enum AgentOp {
    #[serde(rename = "start", rename_all = "camelCase")]
    Start {
        context: AgentContext,
        #[serde(skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        auto_approve_writes: Option<bool>,
    },
    #[serde(rename = "user_message", rename_all = "camelCase")]
    UserMessage {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<AgentContext>,
    },
    #[serde(rename = "db_response", rename_all = "camelCase")]
    DbResponse {
        #[serde(rename = "req_id")]
        req_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "approval_response", rename_all = "camelCase")]
    ApprovalResponse {
        #[serde(rename = "req_id")]
        req_id: String,
        allowed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "set_mode")]
    SetMode { mode: String },
    #[serde(rename = "set_auto_approve")]
    SetAutoApprove { on: bool },
    #[serde(rename = "list_sessions", rename_all = "camelCase")]
    ListSessions {
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<usize>,
    },
    #[serde(rename = "delete_session", rename_all = "camelCase")]
    DeleteSession { session_id: String },
    #[serde(rename = "get_session_messages", rename_all = "camelCase")]
    GetSessionMessages { session_id: String },
    #[serde(rename = "interrupt")]
    Interrupt,
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub ev: String,
    #[serde(flatten)]
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbRequest {
    #[serde(rename = "req_id")]
    pub req_id: String,
    pub func: String,
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    #[serde(rename = "req_id")]
    pub req_id: String,
    pub tool_name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    pub req_id: String,
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_op_variant_tags_use_snake_case_expected_by_sidecar() {
        let op = AgentOp::UserMessage {
            text: "hello".to_string(),
            context: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json.get("op").unwrap(), "user_message");
        assert_eq!(json.get("text").unwrap(), "hello");
    }

    #[test]
    fn agent_op_user_message_can_include_latest_context() {
        let op = AgentOp::UserMessage {
            text: "hello".to_string(),
            context: Some(AgentContext {
                connection_id: Some("demo".to_string()),
                connection_label: None,
                database: Some("game_db".to_string()),
                active_table_name: Some("player".to_string()),
                schema_summary: String::new(),
            }),
        };

        let json = serde_json::to_value(&op).unwrap();
        let context = json.get("context").unwrap();
        assert_eq!(context.get("connectionId").unwrap(), "demo");
        assert_eq!(context.get("database").unwrap(), "game_db");
        assert_eq!(context.get("activeTableName").unwrap(), "player");
    }

    #[test]
    fn agent_op_start_keeps_fields_camel_case() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-test".to_string());
        let context = AgentContext {
            connection_id: Some("conn1".to_string()),
            connection_label: Some("label".to_string()),
            database: Some("db1".to_string()),
            active_table_name: Some("tbl".to_string()),
            schema_summary: "summary".to_string(),
        };
        let op = AgentOp::Start {
            context,
            env: Some(env),
            resume_session_id: Some("resume-1".to_string()),
            permission_mode: Some("default".to_string()),
            model: Some("claude-test".to_string()),
            auto_approve_writes: Some(false),
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json.get("op").unwrap(), "start");
        assert!(json.get("permissionMode").is_some());
        assert!(json.get("resumeSessionId").is_some());
        assert!(json
            .get("context")
            .unwrap()
            .get("activeTableName")
            .is_some());
        assert_eq!(json.get("autoApproveWrites").unwrap(), false);
    }

    #[test]
    fn agent_runtime_control_ops_use_sidecar_wire_names() {
        let set_mode = serde_json::to_value(AgentOp::SetMode {
            mode: "plan".to_string(),
        })
        .unwrap();
        assert_eq!(set_mode.get("op").unwrap(), "set_mode");
        assert_eq!(set_mode.get("mode").unwrap(), "plan");

        let set_auto_approve = serde_json::to_value(AgentOp::SetAutoApprove { on: true }).unwrap();
        assert_eq!(set_auto_approve.get("op").unwrap(), "set_auto_approve");
        assert_eq!(set_auto_approve.get("on").unwrap(), true);
    }

    #[test]
    fn agent_op_db_response_uses_snake_case_req_id() {
        let op = AgentOp::DbResponse {
            req_id: "r1".to_string(),
            ok: true,
            data: None,
            error: None,
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json.get("op").unwrap(), "db_response");
        assert!(json.get("req_id").is_some());
    }

    #[test]
    fn db_request_deserializes_snake_case_req_id() {
        let json = serde_json::json!({
            "req_id": "r1",
            "func": "list_tables",
            "args": { "limit": 10 }
        });
        let req: DbRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.req_id, "r1");
        assert_eq!(req.func, "list_tables");
    }
}
