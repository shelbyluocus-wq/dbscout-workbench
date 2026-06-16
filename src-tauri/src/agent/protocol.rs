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
    pub api_url: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: String,
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
    },
    #[serde(rename = "user_message", rename_all = "camelCase")]
    UserMessage {
        text: String,
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
    #[serde(rename = "list_sessions", rename_all = "camelCase")]
    ListSessions {
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<usize>,
    },
    #[serde(rename = "delete_session", rename_all = "camelCase")]
    DeleteSession {
        session_id: String,
    },
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
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json.get("op").unwrap(), "user_message");
        assert_eq!(json.get("text").unwrap(), "hello");
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
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(json.get("op").unwrap(), "start");
        assert!(json.get("permissionMode").is_some());
        assert!(json.get("resumeSessionId").is_some());
        assert!(json.get("context").unwrap().get("activeTableName").is_some());
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
