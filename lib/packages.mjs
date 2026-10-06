import { RequestError, event, requireOwner } from './team.mjs';

export function validatePackage(body) {
  if (typeof body.name!=='string' || !body.name.trim() || body.name.length>120) throw new RequestError(400,'Package name is required (up to 120 characters)');
  const dimensionUnit=body.dimensionUnit ?? 'cm',weightUnit=body.weightUnit ?? 'kg';
  if (!['cm','in'].includes(dimensionUnit) || !['kg','lb'].includes(weightUnit)) throw new RequestError(400,'Use cm/in dimensions and kg/lb weight');
  const data={name:body.name.trim(),dimensionUnit,weightUnit};
  for (const field of ['length','width','height','weight']) {
    if (body[field]===null || body[field]==='' || typeof body[field]==='boolean') throw new RequestError(400,'Package dimensions and weight must be positive numbers');
    data[field]=Number(body[field]);
    if (!Number.isFinite(data[field]) || data[field]<=0 || data[field]>1000) throw new RequestError(400,'Package dimensions and weight must be positive and at most 1000');
  }
  data.cm={length:data.length*(dimensionUnit==='in'?2.54:1),width:data.width*(dimensionUnit==='in'?2.54:1),height:data.height*(dimensionUnit==='in'?2.54:1)};
  data.kg=data.weight*(weightUnit==='lb'?0.45359237:1);
  if (Object.values(data.cm).some(value=>value>1000) || data.kg>1000) throw new RequestError(400,'Normalized package exceeds supported size or weight');
  return data;
}
export const decodePackage = row=>row && {...row,body:JSON.parse(row.body),archived:!!row.archived};
export function handlePackages({db,path,req,body,user,json}) {
  if (!path.startsWith('/api/packages')) return false;
  if (!user) throw new RequestError(401,'Sign in required');
  if(req.method==='GET' && path==='/api/packages'){json(200,db.prepare('SELECT * FROM saved_packages ORDER BY archived,name COLLATE NOCASE').all().map(decodePackage));return true;}
  requireOwner(user);
  if(req.method==='POST' && path==='/api/packages') {
    const data=validatePackage(body);
    if(db.prepare('SELECT id FROM saved_packages WHERE name=? COLLATE NOCASE AND archived=0').get(data.name))throw new RequestError(409,'An active package already has this name');
    db.exec('BEGIN IMMEDIATE');
    try{
      const id=Number(db.prepare('INSERT INTO saved_packages(name,body,updated_at) VALUES(?,?,?)').run(data.name,JSON.stringify(data),new Date().toISOString()).lastInsertRowid);
      event(db,user,`Created saved package #${id}: ${data.name}`);db.exec('COMMIT');json(201,decodePackage(db.prepare('SELECT * FROM saved_packages WHERE id=?').get(id)));
    }catch(error){db.exec('ROLLBACK');throw error;}return true;
  }
  const match=path.match(/^\/api\/packages\/(\d+)$/);
  if(req.method==='POST' && match) {
    const row=decodePackage(db.prepare('SELECT * FROM saved_packages WHERE id=?').get(Number(match[1])));
    if(!row)throw new RequestError(404,'Saved package not found');
    if(body.version!==row.version)throw new RequestError(409,'Package changed. Refresh before saving');
    if(body.archived!==undefined && typeof body.archived!=='boolean')throw new RequestError(400,'Archived must be true or false');
    const archived=body.archived ?? row.archived,data=validatePackage(body.payload ?? row.body);
    if(!archived && db.prepare('SELECT id FROM saved_packages WHERE name=? COLLATE NOCASE AND archived=0 AND id<>?').get(data.name,row.id))throw new RequestError(409,'An active package already has this name');
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare('UPDATE saved_packages SET name=?,body=?,archived=?,version=version+1,updated_at=? WHERE id=?').run(data.name,JSON.stringify(data),archived?1:0,new Date().toISOString(),row.id);
      event(db,user,`${archived?'Archived':'Updated'} saved package #${row.id}`);db.exec('COMMIT');json(200,decodePackage(db.prepare('SELECT * FROM saved_packages WHERE id=?').get(row.id)));
    }catch(error){db.exec('ROLLBACK');throw error;}return true;
  }
  return false;
}
export function resolvePackage(db,input) {
  const saved=input.savedPackageId ? decodePackage(db.prepare('SELECT * FROM saved_packages WHERE id=? AND archived=0').get(input.savedPackageId)) : null;
  if(input.savedPackageId && !saved)throw new RequestError(409,'Saved package is no longer available. Choose an active package');
  const normalized={id:saved?.id ?? null,version:saved?.version ?? null,name:saved?.name ?? 'Custom package',kg:Number(input.kg ?? saved?.body.kg),length:Number(input.length ?? saved?.body.cm.length),width:Number(input.width ?? saved?.body.cm.width),height:Number(input.height ?? saved?.body.cm.height)};
  if(![normalized.kg,normalized.length,normalized.width,normalized.height].every(value=>Number.isFinite(value)&&value>0&&value<=1000))throw new RequestError(400,'Enter a valid weight and package dimensions');
  return normalized;
}
