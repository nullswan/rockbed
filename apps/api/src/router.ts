import { os, ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  IAMClient,
  CreateUserCommand,
  AttachUserPolicyCommand,
  CreateServiceSpecificCredentialCommand,
  ListServiceSpecificCredentialsCommand,
  DeleteServiceSpecificCredentialCommand,
  UpdateServiceSpecificCredentialCommand,
  ListUsersCommand,
  DetachUserPolicyCommand,
  DeleteUserCommand,
  TagUserCommand,
  ListUserTagsCommand,
} from "@aws-sdk/client-iam";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  GetModelInvocationLoggingConfigurationCommand,
  PutModelInvocationLoggingConfigurationCommand,
} from "@aws-sdk/client-bedrock";
import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  ServiceQuotasClient,
  ListServiceQuotasCommand,
} from "@aws-sdk/client-service-quotas";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  RegionInput,
  CreateKeyInput,
  DeleteKeyInput,
  BEDROCK_POLICY_ARN,
  BEDROCK_SERVICE_NAME,
  USER_PREFIX,
} from "@rockbed/shared";
import { prisma } from "@rockbed/db";

function createClients(region: string) {
  const config = { region };
  return {
    iam: new IAMClient(config),
    bedrock: new BedrockClient(config),
    sts: new STSClient(config),
    quotas: new ServiceQuotasClient(config),
  };
}

// -- Procedures --

const whoAmI = os.input(RegionInput).handler(async ({ input }) => {
  const { sts } = createClients(input.region);
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return {
    account: identity.Account!,
    arn: identity.Arn!,
    userId: identity.UserId!,
  };
});

const listModels = os.input(RegionInput).handler(async ({ input }) => {
  const { bedrock } = createClients(input.region);
  const res = await bedrock.send(new ListFoundationModelsCommand({}));
  return (res.modelSummaries ?? []).map((m) => ({
    modelId: m.modelId!,
    modelName: m.modelName!,
    modelArn: m.modelArn!,
    provider: m.providerName!,
    inputModalities: m.inputModalities ?? [],
    outputModalities: m.outputModalities ?? [],
    streaming: m.responseStreamingSupported ?? false,
    inferenceTypes: m.inferenceTypesSupported ?? [],
    customizations: m.customizationsSupported ?? [],
    lifecycleStatus: m.modelLifecycle?.status ?? "ACTIVE",
    releaseDate: m.modelLifecycle?.startOfLifeTime?.toISOString() ?? null,
  }));
});

const createKey = os.input(CreateKeyInput).handler(async ({ input }) => {
  const { iam } = createClients(input.region);
  const userName = `${USER_PREFIX}${input.name}`;

  // Create IAM user
  try {
    await iam.send(new CreateUserCommand({ UserName: userName }));
  } catch (err: any) {
    if (err.name === "EntityAlreadyExistsException") {
      throw new ORPCError("CONFLICT", {
        message: `A key with name "${input.name}" already exists`,
      });
    }
    throw err;
  }

  // Attach Bedrock policy
  await iam.send(
    new AttachUserPolicyCommand({
      UserName: userName,
      PolicyArn: BEDROCK_POLICY_ARN,
    })
  );

  // Create the service-specific credential (API key)
  const result = await iam.send(
    new CreateServiceSpecificCredentialCommand({
      UserName: userName,
      ServiceName: BEDROCK_SERVICE_NAME,
    })
  );

  const cred = result.ServiceSpecificCredential!;
  const createdAt = cred.CreateDate!;

  let expiresAt: string | null = null;
  if (input.expiryDays > 0) {
    const expiry = new Date(createdAt.getTime() + input.expiryDays * 86400000);
    expiresAt = expiry.toISOString();
  }

  // Tag the IAM user with metadata
  await iam.send(
    new TagUserCommand({
      UserName: userName,
      Tags: [
        { Key: "rockbed:expiryDays", Value: String(input.expiryDays) },
        { Key: "rockbed:expiresAt", Value: expiresAt ?? "never" },
        { Key: "rockbed:createdBy", Value: input.createdBy ?? "unknown" },
        { Key: "rockbed:dailySpendLimit", Value: "100" },
      ],
    })
  );

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: "key.created",
      keyName: input.name,
      userName,
      region: input.region,
      metadata: JSON.stringify({ expiryDays: input.expiryDays, expiresAt, createdBy: input.createdBy }),
    },
  }).catch((e) => console.error("[audit]", e));

  keysCache.delete(input.region);

  return {
    userName,
    credentialId: cred.ServiceSpecificCredentialId!,
    apiKey: cred.ServiceCredentialSecret!,
    apiKeyId: cred.ServiceCredentialAlias!,
    createdAt: createdAt.toISOString(),
    expiresAt,
    status: cred.Status!,
  };
});

// Cache key list for 30s — IAM calls are slow (~40 per load) and key status rarely changes
const keysCache = new Map<string, { data: any[]; expiry: number }>();

// AWS IAM is the ground truth for keys
const listKeys = os.input(RegionInput).handler(async ({ input }) => {
  const cached = keysCache.get(input.region);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const { iam } = createClients(input.region);

  const usersRes = await iam.send(new ListUsersCommand({ PathPrefix: "/" }));
  const bedrockUsers = (usersRes.Users ?? []).filter((u) =>
    u.UserName?.startsWith(USER_PREFIX)
  );

  const keyResults = await Promise.all(
    bedrockUsers.map(async (user) => {
      const [credsRes, tagsRes] = await Promise.all([
        iam.send(
          new ListServiceSpecificCredentialsCommand({
            UserName: user.UserName!,
            ServiceName: BEDROCK_SERVICE_NAME,
          })
        ),
        iam.send(new ListUserTagsCommand({ UserName: user.UserName! })).catch(
          () => ({ Tags: [] })
        ),
      ]);

      const tags = tagsRes.Tags ?? [];
      const expiresAt =
        tags.find((t) => t.Key === "rockbed:expiresAt")?.Value;
      const createdBy =
        tags.find((t) => t.Key === "rockbed:createdBy")?.Value;
      const dailySpendLimit =
        tags.find((t) => t.Key === "rockbed:dailySpendLimit")?.Value;
      const autoDisabledAt =
        tags.find((t) => t.Key === "rockbed:autoDisabledAt")?.Value;

      return (credsRes.ServiceSpecificCredentials ?? []).map((cred) => ({
        userName: user.UserName!,
        friendlyName: user.UserName!.replace(USER_PREFIX, ""),
        credentialId: cred.ServiceSpecificCredentialId!,
        apiKeyId: cred.ServiceCredentialAlias!,
        status: cred.Status!,
        createdAt: cred.CreateDate!.toISOString(),
        expiresAt: expiresAt && expiresAt !== "never" ? expiresAt : null,
        createdBy: createdBy && createdBy !== "unknown" ? createdBy : null,
        dailySpendLimit: dailySpendLimit ?? "none",
        autoDisabledAt: autoDisabledAt ?? null,
      }));
    })
  );

  const data = keyResults.flat();
  keysCache.set(input.region, { data, expiry: Date.now() + 30_000 });
  return data;
});

const deleteKey = os.input(DeleteKeyInput).handler(async ({ input }) => {
  const { iam } = createClients(input.region);

  await iam.send(
    new DeleteServiceSpecificCredentialCommand({
      UserName: input.userName,
      ServiceSpecificCredentialId: input.credentialId,
    })
  );

  try {
    await iam.send(
      new DetachUserPolicyCommand({
        UserName: input.userName,
        PolicyArn: BEDROCK_POLICY_ARN,
      })
    );
    await iam.send(new DeleteUserCommand({ UserName: input.userName }));
  } catch {
    // User may have other credentials; ignore cleanup errors
  }

  keysCache.delete(input.region);

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: "key.deleted",
      keyName: input.userName.replace(USER_PREFIX, ""),
      userName: input.userName,
      region: input.region,
    },
  }).catch((e) => console.error("[audit]", e));

  return { success: true };
});

// Cache quotas for 5 minutes
const quotaCache = new Map<string, { data: any[]; expiry: number }>();

const listQuotas = os.input(RegionInput).handler(async ({ input }) => {
  const cacheKey = input.region;
  const cached = quotaCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const { quotas } = createClients(input.region);
  const allQuotas = [];
  let nextToken: string | undefined;

  do {
    const res = await quotas.send(
      new ListServiceQuotasCommand({
        ServiceCode: "bedrock",
        MaxResults: 100,
        NextToken: nextToken,
      })
    );
    for (const q of res.Quotas ?? []) {
      const name = q.QuotaName ?? "";
      if (!/tokens per minute|requests per minute/i.test(name)) continue;
      allQuotas.push({
        quotaCode: q.QuotaCode!,
        quotaName: name,
        value: q.Value!,
        unit: q.Unit ?? "",
        adjustable: q.Adjustable ?? false,
        globalQuota: q.GlobalQuota ?? false,
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  quotaCache.set(cacheKey, { data: allQuotas, expiry: Date.now() + 300_000 });
  return allQuotas;
});

// -- Favorites --

const listFavorites = os.handler(async () => {
  const favs = await prisma.favoriteModel.findMany({
    orderBy: { createdAt: "desc" },
  });
  return favs.map((f) => f.modelId);
});

const toggleFavorite = os
  .input(z.object({ modelId: z.string() }))
  .handler(async ({ input }) => {
    const existing = await prisma.favoriteModel.findUnique({
      where: { modelId: input.modelId },
    });
    if (existing) {
      await prisma.favoriteModel.delete({
        where: { modelId: input.modelId },
      });
      return { favorited: false };
    } else {
      await prisma.favoriteModel.create({
        data: { modelId: input.modelId },
      });
      return { favorited: true };
    }
  });

// -- Settings --

const getSettings = os.input(RegionInput).handler(async ({ input }) => {
  const [defaultRegion, enabledRegions] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "default_region" } }),
    prisma.setting.findUnique({ where: { key: "enabled_regions" } }),
  ]);

  // Check invocation logging status
  let invocationLoggingEnabled = false;
  try {
    const { bedrock } = createClients(input.region);
    const logConfig = await bedrock.send(
      new GetModelInvocationLoggingConfigurationCommand({})
    );
    invocationLoggingEnabled =
      logConfig.loggingConfig?.textDataDeliveryEnabled === true &&
      !!logConfig.loggingConfig?.cloudWatchConfig?.logGroupName;
  } catch {}

  return {
    defaultRegion: defaultRegion?.value ?? "us-east-1",
    enabledRegions: enabledRegions?.value
      ? enabledRegions.value.split(",").filter(Boolean)
      : ["us-east-1", "us-west-2"],
    invocationLoggingEnabled,
  };
});

const setDefaultRegion = os
  .input(z.object({ region: z.string() }))
  .handler(async ({ input }) => {
    await prisma.setting.upsert({
      where: { key: "default_region" },
      update: { value: input.region },
      create: { key: "default_region", value: input.region },
    });
    return { ok: true };
  });

const setEnabledRegions = os
  .input(z.object({ regions: z.array(z.string()) }))
  .handler(async ({ input }) => {
    await prisma.setting.upsert({
      where: { key: "enabled_regions" },
      update: { value: input.regions.join(",") },
      create: { key: "enabled_regions", value: input.regions.join(",") },
    });
    return { ok: true };
  });

const LOGGING_ROLE_NAME = "RockbedInvocationLoggingRole";
const LOG_GROUP_NAME = "/aws/bedrock/invocation-logs";

const enableInvocationLogging = os
  .input(z.object({ region: z.string(), enable: z.boolean() }))
  .handler(async ({ input }) => {
    const { bedrock, iam } = createClients(input.region);

    if (!input.enable) {
      // Disable by setting textDataDeliveryEnabled to false
      try {
        const current = await bedrock.send(
          new GetModelInvocationLoggingConfigurationCommand({})
        );
        if (current.loggingConfig?.cloudWatchConfig) {
          await bedrock.send(
            new PutModelInvocationLoggingConfigurationCommand({
              loggingConfig: {
                ...current.loggingConfig,
                textDataDeliveryEnabled: false,
              },
            })
          );
        }
      } catch {}
      return { ok: true, enabled: false };
    }

    // Get account ID for role ARN
    const { sts } = createClients(input.region);
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account!;
    const roleArn = `arn:aws:iam::${accountId}:role/${LOGGING_ROLE_NAME}`;

    // Ensure IAM role exists
    try {
      await iam.send(new GetRoleCommand({ RoleName: LOGGING_ROLE_NAME }));
    } catch {
      await iam.send(
        new CreateRoleCommand({
          RoleName: LOGGING_ROLE_NAME,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "bedrock.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
          Description: "Allows Bedrock to write invocation logs to CloudWatch",
        })
      );
      await iam.send(
        new PutRolePolicyCommand({
          RoleName: LOGGING_ROLE_NAME,
          PolicyName: "CloudWatchLogsAccess",
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                ],
                Resource: "arn:aws:logs:*:*:log-group:/aws/bedrock/*",
              },
            ],
          }),
        })
      );
      // Wait for IAM propagation
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Ensure log group exists
    const cwLogs = new CloudWatchLogsClient({ region: input.region });
    try {
      await cwLogs.send(
        new CreateLogGroupCommand({ logGroupName: LOG_GROUP_NAME })
      );
    } catch (e: any) {
      if (e.name !== "ResourceAlreadyExistsException") throw e;
    }

    // Enable logging
    await bedrock.send(
      new PutModelInvocationLoggingConfigurationCommand({
        loggingConfig: {
          textDataDeliveryEnabled: true,
          imageDataDeliveryEnabled: false,
          embeddingDataDeliveryEnabled: false,
          cloudWatchConfig: {
            logGroupName: LOG_GROUP_NAME,
            roleArn,
          },
        },
      })
    );

    return { ok: true, enabled: true };
  });

const setDailyLimit = os
  .input(z.object({
    region: z.string(),
    userName: z.string(),
    limit: z.union([z.number().positive(), z.literal("none")]),
  }))
  .handler(async ({ input }) => {
    const { iam } = createClients(input.region);
    await iam.send(
      new TagUserCommand({
        UserName: input.userName,
        Tags: [{ Key: "rockbed:dailySpendLimit", Value: String(input.limit) }],
      })
    );
    keysCache.delete(input.region);
    return { success: true };
  });

const toggleKey = os
  .input(z.object({
    region: z.string(),
    userName: z.string(),
    credentialId: z.string(),
    active: z.boolean(),
  }))
  .handler(async ({ input }) => {
    const { iam } = createClients(input.region);
    await iam.send(
      new UpdateServiceSpecificCredentialCommand({
        UserName: input.userName,
        ServiceSpecificCredentialId: input.credentialId,
        Status: input.active ? "Active" : "Inactive",
      })
    );
    if (input.active) {
      await iam.send(
        new TagUserCommand({
          UserName: input.userName,
          Tags: [{ Key: "rockbed:autoDisabledAt", Value: "" }],
        })
      );
    }
    keysCache.delete(input.region);
    return { success: true };
  });

// -- Router --

export const router = {
  identity: {
    whoAmI,
  },
  models: {
    list: listModels,
  },
  keys: {
    create: createKey,
    list: listKeys,
    delete: deleteKey,
    setDailyLimit,
    toggle: toggleKey,
  },
  quotas: {
    list: listQuotas,
  },
  favorites: {
    list: listFavorites,
    toggle: toggleFavorite,
  },
  settings: {
    get: getSettings,
    setRegion: setDefaultRegion,
    setEnabledRegions,
    enableInvocationLogging,
  },
};

export type Router = typeof router;
