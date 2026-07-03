#!/usr/bin/env node
import { config } from 'dotenv';
import * as cdk from 'aws-cdk-lib/core';
import { KeycloakStack } from '../lib/stack';

const deployEnv = process.env.DEPLOY_ENV || 'dev';
config({ path: `.env.${deployEnv}` });

const hostedZoneName = process.env.HOSTED_ZONE_NAME;
const domainName = process.env.DOMAIN_NAME;
const albPrefixListId = process.env.ALB_PREFIX_LIST_ID;

if (!hostedZoneName || !domainName) {
  throw new Error(
    'Environment variables "HOSTED_ZONE_NAME" and "DOMAIN_NAME" are required. ' +
    `Check your .env.${deployEnv} file.`
  );
}

const app = new cdk.App();

new KeycloakStack(app, `keycloak-${deployEnv}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'eu-west-1',
  },
  hostedZoneName,
  domainName,
  albPrefixListId,
});
