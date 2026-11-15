export function createOwnerLease(timeout,clock=()=>performance.now()) {
  if(!Number.isFinite(timeout)||timeout<=0)throw Error('Invalid owner lease duration.');
  let expires=clock()+timeout;
  return {
    expired:()=>clock()>=expires,
    renew(){
      const now=clock();
      if(now>=expires)return false;
      expires=now+timeout;
      return true;
    },
  };
}
