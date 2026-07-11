'use strict';

/**
 * Runtime source of truth for the existing RBAC tables.
 *
 * The original migration remains immutable history. Startup bootstrap replays
 * this catalog idempotently so additive roles and permissions do not require a
 * schema migration.
 */

const ROLES = Object.freeze([
  {
    id: 'role_superadmin',
    code: 'SUPERADMIN',
    name: 'Super Admin',
    description: 'Acceso total al sistema, incluida impersonación e infraestructura.',
  },
  {
    id: 'role_platform_admin',
    code: 'PLATFORM_ADMIN',
    name: 'Platform Admin',
    description: 'Operación cotidiana de la plataforma sin impersonación ni gestión RBAC.',
  },
  {
    id: 'role_org_owner',
    code: 'ORG_OWNER',
    name: 'Org Owner',
    description: 'Propietario de organización: billing, miembros y configuración.',
  },
  {
    id: 'role_org_admin',
    code: 'ORG_ADMIN',
    name: 'Org Admin',
    description: 'Administración de organización sin acceso a facturación.',
  },
  {
    id: 'role_org_member',
    code: 'ORG_MEMBER',
    name: 'Org Member',
    description: 'Miembro activo con permisos de producción.',
  },
  {
    id: 'role_org_viewer',
    code: 'ORG_VIEWER',
    name: 'Org Viewer',
    description: 'Acceso de solo lectura a contenido de la organización.',
  },
  {
    id: 'role_user',
    code: 'USER',
    name: 'User',
    description: 'Usuario individual con permisos personales.',
  },
].map(Object.freeze));

const PERMISSION_DESCRIPTIONS = Object.freeze({
  'users.read': 'Leer perfiles de usuario',
  'users.list': 'Listar usuarios',
  'users.create': 'Crear usuarios',
  'users.update': 'Actualizar perfiles de usuario',
  'users.password.reset': 'Restablecer credenciales de usuario',
  'users.impersonate': 'Impersonar usuarios',
  'users.delete': 'Eliminar usuarios',
  'admin.users.read': 'Ver usuarios en el panel administrativo',
  'admin.users.export': 'Exportar usuarios desde el panel administrativo',
  'admin.metrics.read': 'Ver métricas operacionales administrativas',
  'admin.connections.manage': 'Gestionar integraciones administrativas',
  'admin.models.read': 'Ver el catálogo administrativo de modelos',
  'admin.models.manage': 'Gestionar el catálogo de modelos',
  'admin.billing.read': 'Ver pagos y facturación de plataforma',
  'admin.system.read': 'Ver estado y configuración operacional',
  'admin.maintenance.manage': 'Ejecutar mantenimiento operacional',
  'admin.queues.read': 'Ver colas operacionales',
  'admin.queues.manage': 'Gestionar trabajos de colas',
  'admin.webhooks.read': 'Ver entregas de webhooks',
  'admin.api_keys.read': 'Ver credenciales revocadas',
  'admin.api_keys.manage': 'Gestionar credenciales de plataforma',
  'credits.read': 'Ver balance y transacciones de créditos',
  'credits.adjust': 'Ajustar créditos',
  'credits.refund': 'Reembolsar créditos',
  'org.read': 'Leer datos de la organización',
  'org.update': 'Actualizar la organización',
  'org.delete': 'Eliminar la organización',
  'org.billing.manage': 'Gestionar facturación de la organización',
  'org.members.invite': 'Invitar miembros',
  'org.members.remove': 'Remover miembros',
  'org.members.role.update': 'Cambiar roles de miembros',
  'org.audit.read': 'Leer auditoría de la organización',
  'org.settings.update': 'Actualizar configuración de la organización',
  'images.generate': 'Generar imágenes',
  'images.upscale': 'Escalar imágenes',
  'images.moderate': 'Moderar imágenes',
  'images.read': 'Ver imágenes',
  'images.delete': 'Eliminar imágenes',
  'video.generate': 'Generar video',
  'video.read': 'Ver video',
  'paraphrase.use': 'Usar parafraseo',
  'chat.read': 'Leer chats',
  'chat.create': 'Crear chats',
  'chat.update': 'Editar chats',
  'chat.delete': 'Eliminar chats',
  'chat.share': 'Compartir chats',
  'gpt.create': 'Crear GPTs',
  'gpt.update': 'Editar GPTs',
  'gpt.delete': 'Eliminar GPTs',
  'gpt.publish': 'Publicar GPTs',
  'project.create': 'Crear proyectos',
  'project.read': 'Leer proyectos',
  'project.update': 'Editar proyectos',
  'project.delete': 'Eliminar proyectos',
  'project.share': 'Compartir proyectos',
  'thesis.use': 'Usar el generador de tesis',
  'rbac.manage': 'Gestionar roles, permisos y asignaciones',
  'plans.manage': 'Gestionar planes',
  'metrics.read': 'Leer métricas del sistema',
  'audit.read': 'Leer logs de auditoría',
  'audit.export': 'Exportar logs de auditoría',
  'webhooks.manage': 'Gestionar webhooks',
  'search.semantic': 'Usar búsqueda semántica',
  'embeddings.manage': 'Gestionar embeddings',
});

function permissionId(code) {
  return `perm_${code.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

const PERMISSIONS = Object.freeze(
  Object.entries(PERMISSION_DESCRIPTIONS)
    .map(([code, description]) => Object.freeze({
      id: permissionId(code),
      code,
      description,
    })),
);

const ORG_OWNER_PERMISSIONS = [
  'org.read', 'org.update', 'org.billing.manage', 'org.members.invite',
  'org.members.remove', 'org.members.role.update', 'org.audit.read',
  'org.settings.update', 'users.read', 'users.list', 'credits.read',
  'chat.read', 'chat.create', 'chat.update', 'chat.delete', 'chat.share',
  'gpt.create', 'gpt.update', 'gpt.delete', 'gpt.publish',
  'project.create', 'project.read', 'project.update', 'project.delete',
  'project.share', 'images.generate', 'images.upscale', 'images.read',
  'images.delete', 'video.generate', 'video.read', 'paraphrase.use',
  'thesis.use', 'search.semantic',
];

const ORG_ADMIN_PERMISSIONS = ORG_OWNER_PERMISSIONS.filter(
  (code) => code !== 'org.billing.manage',
);

const ORG_MEMBER_PERMISSIONS = [
  'org.read', 'credits.read', 'chat.read', 'chat.create', 'chat.update',
  'chat.delete', 'chat.share', 'gpt.create', 'gpt.update', 'gpt.delete',
  'project.create', 'project.read', 'project.update', 'project.delete',
  'project.share', 'images.generate', 'images.read', 'images.delete',
  'video.generate', 'video.read', 'paraphrase.use', 'thesis.use',
  'search.semantic',
];

const USER_PERMISSIONS = ORG_MEMBER_PERMISSIONS.filter(
  (code) => code !== 'org.read' && code !== 'search.semantic',
);

const PLATFORM_ADMIN_PERMISSIONS = [
  'users.create',
  'users.update',
  'users.delete',
  'admin.users.read',
  'admin.users.export',
  'admin.metrics.read',
  'admin.connections.manage',
  'admin.models.read',
  'admin.models.manage',
  'admin.billing.read',
  'admin.system.read',
  'admin.maintenance.manage',
  'admin.queues.read',
  'metrics.read',
  'audit.read',
  'audit.export',
];

const ROLE_PERMISSIONS = Object.freeze({
  SUPERADMIN: Object.freeze(PERMISSIONS.map((permission) => permission.code)),
  PLATFORM_ADMIN: Object.freeze(PLATFORM_ADMIN_PERMISSIONS),
  ORG_OWNER: Object.freeze(ORG_OWNER_PERMISSIONS),
  ORG_ADMIN: Object.freeze(ORG_ADMIN_PERMISSIONS),
  ORG_MEMBER: Object.freeze(ORG_MEMBER_PERMISSIONS),
  ORG_VIEWER: Object.freeze([
    'org.read', 'chat.read', 'project.read', 'images.read', 'video.read',
  ]),
  USER: Object.freeze(USER_PERMISSIONS),
});

const ORG_ROLE_TO_ROLE_CODE = Object.freeze({
  OWNER: 'ORG_OWNER',
  ADMIN: 'ORG_ADMIN',
  MEMBER: 'ORG_MEMBER',
  VIEWER: 'ORG_VIEWER',
});

const ROLE_CODES = Object.freeze(ROLES.map((role) => role.code));
const GLOBAL_ROLE_CODES = Object.freeze(['SUPERADMIN', 'PLATFORM_ADMIN', 'USER']);
const ORG_ROLE_CODES = Object.freeze(Object.values(ORG_ROLE_TO_ROLE_CODE));

module.exports = {
  ROLES,
  ROLE_CODES,
  GLOBAL_ROLE_CODES,
  ORG_ROLE_CODES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ORG_ROLE_TO_ROLE_CODE,
};
