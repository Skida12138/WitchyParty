use super::tier_for;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Material {
    pub name: String,
    pub price: i64,
    pub tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl Material {
    pub fn new(name: String, price: i64) -> Self {
        Self {
            name,
            price,
            tier: tier_for(price).to_owned(),
            source: None,
        }
    }

    pub(crate) fn without_source(&self) -> Self {
        Self::new(self.name.clone(), self.price)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Quote {
    pub id: String,
    #[serde(flatten)]
    pub material: Material,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Contribution {
    pub id: String,
    pub owner_id: String,
    pub owner_name: String,
    #[serde(flatten)]
    pub material: Material,
    pub order: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PotMaterial {
    pub id: String,
    pub owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(flatten)]
    pub material: Material,
    pub order: usize,
}

impl From<&Contribution> for PotMaterial {
    fn from(contribution: &Contribution) -> Self {
        Self {
            id: contribution.id.clone(),
            owner_id: Some(contribution.owner_id.clone()),
            owner_name: Some(contribution.owner_name.clone()),
            material: contribution.material.clone(),
            order: contribution.order,
        }
    }
}
