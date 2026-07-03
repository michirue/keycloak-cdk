# keycloak-cdk

CDK stack for deploying Keycloak on ECS Fargate (ARM64/Graviton) with Aurora PostgreSQL Serverless v2.

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch for changes and compile |
| `npm run test` | Run Jest unit tests |
| `npm run clean` | Remove all build artifacts (cdk.out, .cdk.staging, compiled .js/.d.ts) |
| `npx cdk synth` | Emit the synthesized CloudFormation template |
| `npx cdk diff` | Compare deployed stack with current state |
| `npx cdk deploy` | Deploy the stack |
| `npm run deploy` | Run tests, then deploy the stack (deploy is skipped if tests fail) |

## Configuration

Environment-specific config is loaded from `.env.<DEPLOY_ENV>` (defaults to `.env.dev`).

| Variable | Description |
|----------|-------------|
| `AWS_PROFILE` | AWS CLI profile to use |
| `AWS_REGION` | Target AWS region |
| `HOSTED_ZONE_NAME` | Route 53 hosted zone |
| `DOMAIN_NAME` | FQDN for Keycloak |
| `ALB_PREFIX_LIST_ID` | Optional. Prefix list allowed inbound on the ALB (port 443). If unset, the ALB is open to `0.0.0.0/0`. The NAT gateway egress IP is always allowed so tasks can reach their own endpoint. |

To deploy a specific environment:

```sh
DEPLOY_ENV=dev npm run deploy
```

## License

Released under the [MIT License](LICENSE).
